use crate::outline::decode_pdf_string;
use crate::types::*;
use lopdf::{dictionary, Dictionary, Document, Object, ObjectId};
use std::collections::{HashMap, HashSet};
use std::path::Path;

#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("PDF parsing error: {0}")]
    Pdf(#[from] lopdf::Error),
    #[error("Pdfium engine error: {0}")]
    Pdfium(String),
    #[error("Page index {0} out of range (document has {1} pages)")]
    PageOutOfRange(usize, usize),
    #[error("Invalid operation: {0}")]
    InvalidOperation(String),
    #[error("Document is password protected")]
    PasswordProtected,
    #[error("Data validation failed: {0}")]
    ValidationFailed(String),
}

#[derive(Clone)]
pub struct DocumentState {
    pub doc: Document,
    page_ids: Vec<ObjectId>,
    pub annotations: HashMap<usize, Vec<AnnotationDto>>,
}

impl DocumentState {
    /// Loads a PDF from a byte buffer.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, CoreError> {
        let doc = Document::load_mem(bytes)?;
        let mut state = Self {
            doc,
            page_ids: Vec::new(),
            annotations: HashMap::new(),
        };
        state.rebuild_page_ids()?;
        Ok(state)
    }

    /// Loads a PDF from a file path.
    pub fn from_file<P: AsRef<Path>>(path: P) -> Result<Self, CoreError> {
        let bytes = std::fs::read(path)?;
        Self::from_bytes(&bytes)
    }

    /// Creates an empty document with 1 blank page.
    pub fn new_blank(width: f64, height: f64) -> Result<Self, CoreError> {
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();

        let page_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), width.into(), height.into()],
        });

        let pages_dict = dictionary! {
            "Type" => "Pages",
            "Kids" => vec![page_id.into()],
            "Count" => 1,
            "MediaBox" => vec![0.into(), 0.into(), width.into(), height.into()],
        };
        doc.objects.insert(pages_id, Object::Dictionary(pages_dict));

        let catalog_id = doc.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        doc.trailer.set("Root", catalog_id);

        let mut state = Self {
            doc,
            page_ids: vec![page_id],
            annotations: HashMap::new(),
        };
        state.rebuild_page_ids()?;
        Ok(state)
    }

    /// Rebuilds the ordered vector of page object IDs directly from the document page tree.
    pub fn rebuild_page_ids(&mut self) -> Result<(), CoreError> {
        let mut page_list = Vec::new();
        let pages_map = self.doc.get_pages();
        let mut page_num_map: Vec<_> = pages_map.into_iter().collect();
        // Sort by 1-based page number
        page_num_map.sort_by_key(|(p_num, _)| *p_num);
        for (_, obj_id) in page_num_map {
            page_list.push(obj_id);
        }
        self.page_ids = page_list;
        Ok(())
    }

    pub fn page_count(&self) -> usize {
        self.page_ids.len()
    }

    pub fn get_page_id(&self, page_index: usize) -> Result<ObjectId, CoreError> {
        self.page_ids
            .get(page_index)
            .copied()
            .ok_or_else(|| CoreError::PageOutOfRange(page_index, self.page_count()))
    }

    pub fn get_page_info(&self, page_index: usize) -> Result<PageInfo, CoreError> {
        let page_id = self.get_page_id(page_index)?;
        let inherited = |key: &[u8]| {
            let mut current = self.doc.get_dictionary(page_id).ok();
            let mut visited = std::collections::HashSet::new();
            while let Some(dict) = current {
                if let Ok(value) = dict.get_deref(key, &self.doc) {
                    return Some(value);
                }
                let parent = dict.get(b"Parent").ok()?.as_reference().ok()?;
                if !visited.insert(parent) {
                    return None;
                }
                current = self.doc.get_dictionary(parent).ok();
            }
            None
        };
        let read_box = |key: &[u8]| {
            let rect = inherited(key)?.as_array().ok()?;
            let numbers: Vec<_> = rect
                .iter()
                .map(|item| match item {
                    Object::Real(value) => Some(*value as f64),
                    Object::Integer(value) => Some(*value as f64),
                    _ => None,
                })
                .collect::<Option<_>>()?;
            PageBox::from_rect_array(&numbers).filter(|rect| rect.width > 0.0 && rect.height > 0.0)
        };
        let media_box = read_box(b"MediaBox").unwrap_or(PageBox::new(0.0, 0.0, 612.0, 792.0));
        let crop_box = read_box(b"CropBox");
        let rotation = inherited(b"Rotate")
            .and_then(|object| object.as_i64().ok())
            .unwrap_or(0) as i32;
        let visible = crop_box
            .and_then(|crop| crop.intersection(&media_box))
            .unwrap_or(media_box);
        let (width, height) = match rotation.rem_euclid(360) {
            90 | 270 => (visible.height, visible.width),
            _ => (visible.width, visible.height),
        };

        Ok(PageInfo {
            index: page_index,
            width,
            height,
            rotation,
            media_box,
            crop_box,
            label: None,
        })
    }

    /// Computes logical page labels from the catalog's `/PageLabels` number tree (PDF 1.7 §12.4.2).
    pub fn get_page_labels(&self) -> Vec<Option<String>> {
        let count = self.page_count();
        if count == 0 {
            return Vec::new();
        }
        let Ok(root_ref) = self.doc.trailer.get(b"Root").and_then(|o| o.as_reference()) else {
            return vec![None; count];
        };
        let Ok(catalog) = self.doc.get_dictionary(root_ref) else {
            return vec![None; count];
        };
        let Ok(labels_obj) = catalog.get_deref(b"PageLabels", &self.doc) else {
            return vec![None; count];
        };
        let Ok(labels_dict) = labels_obj.as_dict() else {
            return vec![None; count];
        };

        let mut ranges: Vec<(usize, PageLabelRange)> = Vec::new();
        let mut visited = std::collections::HashSet::new();
        collect_page_label_ranges(&self.doc, labels_dict, &mut ranges, &mut visited);
        if ranges.is_empty() {
            return vec![None; count];
        }
        ranges.sort_by_key(|(start, _)| *start);

        let mut out = Vec::with_capacity(count);
        for page_idx in 0..count {
            let entry = ranges.iter().rfind(|(start, _)| *start <= page_idx);
            let label = entry.and_then(|(start_idx, range)| {
                let offset = (page_idx - *start_idx) as i64;
                let num = range.start.saturating_add(offset);
                let num_part = match range.style {
                    Some(PageLabelStyle::Decimal) => Some(num.to_string()),
                    Some(PageLabelStyle::UpperRoman) => to_roman(num).map(|s| s.to_uppercase()),
                    Some(PageLabelStyle::LowerRoman) => to_roman(num),
                    Some(PageLabelStyle::UpperAlpha) => to_alpha(num, true),
                    Some(PageLabelStyle::LowerAlpha) => to_alpha(num, false),
                    None => None,
                };
                let combined = match num_part {
                    Some(n) => format!("{}{}", range.prefix, n),
                    None => range.prefix.clone(),
                };
                if combined.is_empty() {
                    None
                } else {
                    Some(combined)
                }
            });
            out.push(label);
        }
        out
    }

    pub fn get_metadata(&self, file_size_bytes: u64) -> DocumentMetadata {
        let mut meta = DocumentMetadata {
            page_count: self.page_count(),
            file_size_bytes,
            is_encrypted: self.doc.is_encrypted(),
            ..Default::default()
        };

        if let Ok(info_ref) = self.doc.trailer.get(b"Info") {
            if let Ok(info_id) = info_ref.as_reference() {
                if let Ok(info_dict) = self.doc.get_dictionary(info_id) {
                    let read_str = |key: &[u8]| -> Option<String> {
                        info_dict.get(key).ok().and_then(|obj| match obj {
                            Object::String(bytes, _) => Some(decode_pdf_string(bytes)),
                            _ => obj.as_str().ok().map(decode_pdf_string),
                        })
                    };
                    meta.title = read_str(b"Title");
                    meta.author = read_str(b"Author");
                    meta.subject = read_str(b"Subject");
                    meta.keywords = read_str(b"Keywords");
                    meta.creator = read_str(b"Creator");
                    meta.producer = read_str(b"Producer");
                }
            }
        }
        meta
    }

    /// Updates document /Info metadata fields. None or empty string clears the field.
    pub fn update_metadata(&mut self, update: &DocumentMetadataUpdate) -> Result<(), CoreError> {
        let info_id = match self
            .doc
            .trailer
            .get(b"Info")
            .ok()
            .and_then(|o| o.as_reference().ok())
        {
            Some(id) if self.doc.get_dictionary(id).is_ok() => id,
            _ => {
                let id = self.doc.add_object(Dictionary::new());
                self.doc.trailer.set("Info", id);
                id
            }
        };

        let info_dict = self.doc.get_dictionary_mut(info_id)?;
        let mut set_or_remove = |key: &str, value: &Option<String>| match value {
            Some(val) if !val.trim().is_empty() => {
                info_dict.set(key, Object::string_literal(val.as_str()));
            }
            _ => {
                info_dict.remove(key.as_bytes());
            }
        };
        set_or_remove("Title", &update.title);
        set_or_remove("Author", &update.author);
        set_or_remove("Subject", &update.subject);
        set_or_remove("Keywords", &update.keywords);
        set_or_remove("Creator", &update.creator);
        set_or_remove("Producer", &update.producer);
        Ok(())
    }

    /// Strips /Info dictionary, Catalog XMP /Metadata, /PieceInfo, and prunes orphaned objects.
    pub fn strip_metadata(&mut self) -> Result<(), CoreError> {
        self.doc.trailer.remove(b"Info");
        if let Ok(root_id) = self.doc.trailer.get(b"Root").and_then(|o| o.as_reference()) {
            if let Ok(catalog) = self.doc.get_dictionary_mut(root_id) {
                catalog.remove(b"Metadata");
                catalog.remove(b"PieceInfo");
                catalog.remove(b"SpiderInfo");
            }
        }
        for &page_id in &self.page_ids {
            if let Ok(page_dict) = self.doc.get_dictionary_mut(page_id) {
                page_dict.remove(b"Metadata");
                page_dict.remove(b"PieceInfo");
            }
        }
        self.doc.prune_objects();
        Ok(())
    }

    /// Extracts the document's bookmark/outline hierarchy.
    pub fn get_outline(&self) -> Result<Vec<OutlineItem>, CoreError> {
        crate::outline::extract_outline(self)
    }

    /// Replaces the document's bookmark/outline hierarchy.
    pub fn set_outline(&mut self, items: &[OutlineItem]) -> Result<(), CoreError> {
        crate::outline::write_outline(self, items)
    }

    /// Merges all pages from external PDF files at `insert_at` (or appends when None).
    /// Returns the list of newly added object IDs and newly inserted page IDs.
    pub fn merge_pdfs<P: AsRef<Path>>(
        &mut self,
        paths: &[P],
        insert_at: Option<usize>,
    ) -> Result<(Vec<ObjectId>, Vec<ObjectId>), CoreError> {
        let mut all_added = Vec::new();
        let mut all_new_pages = Vec::new();

        for path in paths {
            let other = Document::load(path.as_ref())?;
            let (added, pages) = self.copy_pages_from_document(&other)?;
            all_added.extend(added);
            all_new_pages.extend(pages);
        }

        if all_new_pages.is_empty() {
            return Ok((all_added, all_new_pages));
        }

        let pos = insert_at.unwrap_or(self.page_ids.len()).min(self.page_ids.len());
        let shift = all_new_pages.len();

        let mut new_ids = self.page_ids.clone();
        for (offset, &pid) in all_new_pages.iter().enumerate() {
            new_ids.insert(pos + offset, pid);
        }
        self.apply_page_ids_to_tree(&new_ids)?;
        self.page_ids = new_ids;

        // Shift in-memory annotations for pages at or after `pos`
        if !self.annotations.is_empty() {
            let old_annots = std::mem::take(&mut self.annotations);
            for (idx, mut list) in old_annots {
                let target_idx = if idx >= pos { idx + shift } else { idx };
                for annot in &mut list {
                    annot.page_index = target_idx;
                }
                self.annotations.insert(target_idx, list);
            }
        }

        Ok((all_added, all_new_pages))
    }

    /// Extracts selected 0-based page indices into a new PDF saved at `target_path`.
    pub fn extract_pages<P: AsRef<Path>>(
        &self,
        pages: &[usize],
        target_path: P,
    ) -> Result<(), CoreError> {
        if pages.is_empty() {
            return Err(CoreError::InvalidOperation(
                "No pages specified for extraction".into(),
            ));
        }
        for &p in pages {
            if p >= self.page_ids.len() {
                return Err(CoreError::PageOutOfRange(p, self.page_ids.len()));
            }
        }

        // Clone and commit any in-memory annotations for extracted pages so they are preserved.
        let mut source = self.clone();
        let selected_set: HashSet<usize> = pages.iter().copied().collect();
        source.annotations.retain(|idx, _| selected_set.contains(idx));
        crate::annotations::commit_annotations_to_pdf(&mut source)?;

        let mut out_doc = Document::with_version(source.doc.version.clone());
        let pages_id = out_doc.new_object_id();
        let mut remap = HashMap::new();
        let mut new_page_ids = Vec::with_capacity(pages.len());

        for &idx in pages {
            let src_page_id = source.get_page_id(idx)?;
            let new_pid = copy_page_object(&source.doc, src_page_id, &mut out_doc, pages_id, &mut remap)?;
            new_page_ids.push(new_pid);
        }

        let pages_dict = dictionary! {
            "Type" => "Pages",
            "Kids" => new_page_ids.iter().map(|&id| Object::Reference(id)).collect::<Vec<_>>(),
            "Count" => new_page_ids.len() as i64,
        };
        out_doc.objects.insert(pages_id, Object::Dictionary(pages_dict));

        let catalog_id = out_doc.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        out_doc.trailer.set("Root", catalog_id);

        let mut out_state = DocumentState {
            doc: out_doc,
            page_ids: new_page_ids,
            annotations: HashMap::new(),
        };
        out_state.rebuild_page_ids()?;
        crate::persistence::safe_save(&mut out_state, target_path, false)?;
        Ok(())
    }

    fn copy_pages_from_document(
        &mut self,
        other: &Document,
    ) -> Result<(Vec<ObjectId>, Vec<ObjectId>), CoreError> {
        let root_id = self.doc.trailer.get(b"Root")?.as_reference()?;
        let root_dict = self.doc.get_dictionary(root_id)?;
        let pages_id = root_dict.get(b"Pages")?.as_reference()?;

        let mut other_pages: Vec<_> = other.get_pages().into_iter().collect();
        other_pages.sort_by_key(|(num, _)| *num);

        let mut remap = HashMap::new();
        let mut new_page_ids = Vec::with_capacity(other_pages.len());

        for (_, src_page_id) in other_pages {
            let new_pid = copy_page_object(other, src_page_id, &mut self.doc, pages_id, &mut remap)?;
            new_page_ids.push(new_pid);
        }

        let added_objects: Vec<ObjectId> = remap.values().copied().collect();
        Ok((added_objects, new_page_ids))
    }

    /// Reorders pages according to the given permutation of indices.
    pub fn reorder_pages(&mut self, new_order: &[usize]) -> Result<(), CoreError> {
        if new_order.len() != self.page_ids.len() {
            return Err(CoreError::InvalidOperation(
                "Permutation length mismatch".into(),
            ));
        }

        let new_page_ids: Vec<ObjectId> = new_order
            .iter()
            .map(|&idx| {
                self.page_ids
                    .get(idx)
                    .copied()
                    .ok_or(CoreError::PageOutOfRange(idx, self.page_ids.len()))
            })
            .collect::<Result<_, _>>()?;

        self.apply_page_ids_to_tree(&new_page_ids)?;
        self.page_ids = new_page_ids;
        Ok(())
    }

    /// Rotates specified pages by delta_deg (e.g. +90, -90, 180).
    pub fn rotate_pages(&mut self, pages: &[usize], delta_deg: i32) -> Result<(), CoreError> {
        for &page_idx in pages {
            let page_id = self.get_page_id(page_idx)?;
            let page_dict = self.doc.get_dictionary_mut(page_id)?;
            let current_rot = if let Ok(rot) = page_dict.get(b"Rotate") {
                rot.as_i64().unwrap_or(0) as i32
            } else {
                0
            };
            let mut new_rot = (current_rot + delta_deg) % 360;
            if new_rot < 0 {
                new_rot += 360;
            }
            page_dict.set("Rotate", new_rot);
        }
        Ok(())
    }

    /// Sets or clears non-destructive CropBox.
    pub fn set_crop_box(
        &mut self,
        pages: &[usize],
        crop_box: Option<PageBox>,
    ) -> Result<(), CoreError> {
        for &page_idx in pages {
            let page_id = self.get_page_id(page_idx)?;
            let page_dict = self.doc.get_dictionary_mut(page_id)?;
            if let Some(cb) = crop_box {
                page_dict.set(
                    "CropBox",
                    vec![
                        cb.x.into(),
                        cb.y.into(),
                        (cb.x + cb.width).into(),
                        (cb.y + cb.height).into(),
                    ],
                );
            } else {
                page_dict.remove(b"CropBox");
            }
        }
        Ok(())
    }

    /// Sets MediaBox for specified pages.
    pub fn set_media_box(&mut self, pages: &[usize], media_box: PageBox) -> Result<(), CoreError> {
        for &page_idx in pages {
            let page_id = self.get_page_id(page_idx)?;
            let page_dict = self.doc.get_dictionary_mut(page_id)?;
            page_dict.set(
                "MediaBox",
                vec![
                    media_box.x.into(),
                    media_box.y.into(),
                    (media_box.x + media_box.width).into(),
                    (media_box.y + media_box.height).into(),
                ],
            );
        }
        Ok(())
    }

    /// Deletes pages at the specified indices.
    pub fn delete_pages(&mut self, pages_to_delete: &[usize]) -> Result<(), CoreError> {
        if pages_to_delete.is_empty() {
            return Ok(());
        }
        let mut delete_set = std::collections::HashSet::new();
        for &p in pages_to_delete {
            if p >= self.page_ids.len() {
                return Err(CoreError::PageOutOfRange(p, self.page_ids.len()));
            }
            delete_set.insert(p);
        }

        if delete_set.len() >= self.page_ids.len() {
            return Err(CoreError::InvalidOperation(
                "Cannot delete all pages in document".into(),
            ));
        }

        let remaining_ids: Vec<ObjectId> = self
            .page_ids
            .iter()
            .enumerate()
            .filter(|(idx, _)| !delete_set.contains(idx))
            .map(|(_, &id)| id)
            .collect();

        self.apply_page_ids_to_tree(&remaining_ids)?;
        self.page_ids = remaining_ids;
        Ok(())
    }

    /// Duplicates specified pages immediately following each target page.
    pub fn duplicate_pages(&mut self, pages_to_duplicate: &[usize]) -> Result<(), CoreError> {
        let mut new_ids = self.page_ids.clone();
        for &p in pages_to_duplicate.iter().rev() {
            let original_id = self.get_page_id(p)?;
            let orig_dict = self.doc.get_dictionary(original_id)?.clone();
            let dup_id = self.doc.add_object(Object::Dictionary(orig_dict));
            new_ids.insert(p + 1, dup_id);
        }
        self.apply_page_ids_to_tree(&new_ids)?;
        self.page_ids = new_ids;
        Ok(())
    }

    /// Inserts a blank page at the given index.
    pub fn insert_blank_page(
        &mut self,
        at: usize,
        width: f64,
        height: f64,
    ) -> Result<(), CoreError> {
        let root_dict = self
            .doc
            .get_dictionary(self.doc.trailer.get(b"Root")?.as_reference()?)?;
        let pages_id = root_dict.get(b"Pages")?.as_reference()?;

        let blank_page_id = self.doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), width.into(), height.into()],
        });

        let mut new_ids = self.page_ids.clone();
        let target_pos = at.min(new_ids.len());
        new_ids.insert(target_pos, blank_page_id);

        self.apply_page_ids_to_tree(&new_ids)?;
        self.page_ids = new_ids;
        Ok(())
    }

    /// Reverses the document page order.
    pub fn reverse_pages(&mut self) -> Result<(), CoreError> {
        let mut reversed = self.page_ids.clone();
        reversed.reverse();
        self.apply_page_ids_to_tree(&reversed)?;
        self.page_ids = reversed;
        Ok(())
    }

    /// Directly applies a specific ordering of page IDs to the document tree.
    pub fn apply_page_ids(&mut self, target_ids: &[ObjectId]) -> Result<(), CoreError> {
        self.apply_page_ids_to_tree(target_ids)?;
        self.page_ids = target_ids.to_vec();
        Ok(())
    }

    /// Rewrites the Pages tree Kids array and updates Count.
    fn apply_page_ids_to_tree(&mut self, target_ids: &[ObjectId]) -> Result<(), CoreError> {
        let root_id = self.doc.trailer.get(b"Root")?.as_reference()?;
        let root_dict = self.doc.get_dictionary(root_id)?;
        let pages_id = root_dict.get(b"Pages")?.as_reference()?;

        let pages_node = self.doc.get_dictionary_mut(pages_id)?;
        let kids_vec: Vec<Object> = target_ids.iter().map(|&id| Object::Reference(id)).collect();
        pages_node.set("Kids", kids_vec);
        pages_node.set("Count", target_ids.len() as i64);

        // Also ensure each page's Parent points to this pages_id
        for &p_id in target_ids {
            if let Ok(p_dict) = self.doc.get_dictionary_mut(p_id) {
                p_dict.set("Parent", pages_id);
            }
        }
        Ok(())
    }

    /// Serializes document into PDF byte buffer.
    pub fn to_bytes(&mut self) -> Result<Vec<u8>, CoreError> {
        let mut buf = Vec::new();
        self.doc.save_to(&mut buf)?;
        Ok(buf)
    }

    /// Saves document to file.
    pub fn save_to_file<P: AsRef<Path>>(&mut self, path: P) -> Result<(), CoreError> {
        self.doc.save(path)?;
        Ok(())
    }
}

fn find_inherited_page_attr(src: &Document, page_id: ObjectId, key: &[u8]) -> Option<Object> {
    let mut current = src.get_dictionary(page_id).ok();
    let mut visited = HashSet::new();
    while let Some(dict) = current {
        if let Ok(val) = dict.get(key) {
            return Some(val.clone());
        }
        let parent_id = dict.get(b"Parent").ok()?.as_reference().ok()?;
        if !visited.insert(parent_id) {
            return None;
        }
        current = src.get_dictionary(parent_id).ok();
    }
    None
}

fn copy_page_object(
    src: &Document,
    src_page_id: ObjectId,
    dst: &mut Document,
    dst_pages_id: ObjectId,
    remap: &mut HashMap<ObjectId, ObjectId>,
) -> Result<ObjectId, CoreError> {
    if let Some(&existing) = remap.get(&src_page_id) {
        return Ok(existing);
    }

    let dst_page_id = dst.new_object_id();
    remap.insert(src_page_id, dst_page_id);

    let mut page_dict = src.get_dictionary(src_page_id)?.clone();
    // Ensure inherited page attributes are materialized before detaching from source /Pages tree.
    for key in [b"MediaBox".as_slice(), b"CropBox", b"Resources", b"Rotate"] {
        if page_dict.get(key).is_err() {
            if let Some(inherited) = find_inherited_page_attr(src, src_page_id, key) {
                page_dict.set(key, inherited);
            }
        }
    }

    let mut copied_dict = Dictionary::new();
    for (k, v) in page_dict.iter() {
        if k == b"Parent" || k == b"B" || k == b"StructParents" {
            continue;
        }
        let copied_val = deep_copy_object(src, v, dst, remap)?;
        copied_dict.set(k.clone(), copied_val);
    }
    copied_dict.set("Type", "Page");
    copied_dict.set("Parent", dst_pages_id);

    dst.objects.insert(dst_page_id, Object::Dictionary(copied_dict));
    Ok(dst_page_id)
}

fn deep_copy_object(
    src: &Document,
    obj: &Object,
    dst: &mut Document,
    remap: &mut HashMap<ObjectId, ObjectId>,
) -> Result<Object, CoreError> {
    match obj {
        Object::Reference(src_id) => {
            if let Some(&dst_id) = remap.get(src_id) {
                return Ok(Object::Reference(dst_id));
            }
            let Ok(target) = src.get_object(*src_id) else {
                return Ok(Object::Null);
            };
            // Avoid accidentally pulling in unrelated page tree nodes if an annotation or action links to another page
            if let Ok(dict) = target.as_dict() {
                if dict.get(b"Type").and_then(|o| o.as_name()).ok() == Some(b"Pages") {
                    return Ok(Object::Null);
                }
            }
            let dst_id = dst.new_object_id();
            remap.insert(*src_id, dst_id);
            let copied_target = deep_copy_object(src, target, dst, remap)?;
            dst.objects.insert(dst_id, copied_target);
            Ok(Object::Reference(dst_id))
        }
        Object::Array(arr) => {
            let mut out = Vec::with_capacity(arr.len());
            for item in arr {
                out.push(deep_copy_object(src, item, dst, remap)?);
            }
            Ok(Object::Array(out))
        }
        Object::Dictionary(dict) => {
            let mut out = Dictionary::new();
            for (k, v) in dict.iter() {
                out.set(k.clone(), deep_copy_object(src, v, dst, remap)?);
            }
            Ok(Object::Dictionary(out))
        }
        Object::Stream(stream) => {
            let mut out_dict = Dictionary::new();
            for (k, v) in stream.dict.iter() {
                out_dict.set(k.clone(), deep_copy_object(src, v, dst, remap)?);
            }
            let mut new_stream = lopdf::Stream::new(out_dict, stream.content.clone());
            new_stream.allows_compression = stream.allows_compression;
            Ok(Object::Stream(new_stream))
        }
        primitive => Ok(primitive.clone()),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PageLabelStyle {
    Decimal,
    UpperRoman,
    LowerRoman,
    UpperAlpha,
    LowerAlpha,
}

#[derive(Debug, Clone)]
struct PageLabelRange {
    style: Option<PageLabelStyle>,
    prefix: String,
    start: i64,
}

fn collect_page_label_ranges(
    doc: &Document,
    node: &Dictionary,
    out: &mut Vec<(usize, PageLabelRange)>,
    visited: &mut std::collections::HashSet<ObjectId>,
) {
    if let Ok(nums_obj) = node.get_deref(b"Nums", doc) {
        if let Ok(nums) = nums_obj.as_array() {
            for pair in nums.chunks_exact(2) {
                let Ok(page_idx) = pair[0].as_i64() else {
                    continue;
                };
                if page_idx < 0 {
                    continue;
                }
                let dict_obj = match &pair[1] {
                    Object::Reference(id) => doc.get_object(*id).ok(),
                    other => Some(other),
                };
                let Some(Ok(label_dict)) = dict_obj.map(|o| o.as_dict()) else {
                    continue;
                };
                let style = label_dict
                    .get_deref(b"S", doc)
                    .ok()
                    .and_then(|o| o.as_name().ok())
                    .and_then(|name| match name {
                        b"D" => Some(PageLabelStyle::Decimal),
                        b"R" => Some(PageLabelStyle::UpperRoman),
                        b"r" => Some(PageLabelStyle::LowerRoman),
                        b"A" => Some(PageLabelStyle::UpperAlpha),
                        b"a" => Some(PageLabelStyle::LowerAlpha),
                        _ => None,
                    });
                let prefix = label_dict
                    .get_deref(b"P", doc)
                    .ok()
                    .and_then(|o| match o {
                        Object::String(bytes, _) => Some(decode_pdf_string(bytes)),
                        _ => o.as_str().ok().map(decode_pdf_string),
                    })
                    .unwrap_or_default();
                let start = label_dict
                    .get_deref(b"St", doc)
                    .ok()
                    .and_then(|o| o.as_i64().ok())
                    .filter(|&v| v >= 1)
                    .unwrap_or(1);
                out.push((
                    page_idx as usize,
                    PageLabelRange {
                        style,
                        prefix,
                        start,
                    },
                ));
            }
        }
    }

    if let Ok(kids_obj) = node.get_deref(b"Kids", doc) {
        if let Ok(kids) = kids_obj.as_array() {
            for kid in kids {
                if let Ok(kid_id) = kid.as_reference() {
                    if !visited.insert(kid_id) {
                        continue;
                    }
                    if let Ok(kid_dict) = doc.get_dictionary(kid_id) {
                        collect_page_label_ranges(doc, kid_dict, out, visited);
                    }
                }
            }
        }
    }
}

fn to_roman(num: i64) -> Option<String> {
    if num <= 0 || num > 3999 {
        return None;
    }
    const TABLE: &[(i64, &str)] = &[
        (1000, "m"),
        (900, "cm"),
        (500, "d"),
        (400, "cd"),
        (100, "c"),
        (90, "xc"),
        (50, "l"),
        (40, "xl"),
        (10, "x"),
        (9, "ix"),
        (5, "v"),
        (4, "iv"),
        (1, "i"),
    ];
    let mut n = num;
    let mut res = String::new();
    for &(val, sym) in TABLE {
        while n >= val {
            res.push_str(sym);
            n -= val;
        }
    }
    Some(res)
}

fn to_alpha(num: i64, uppercase: bool) -> Option<String> {
    if num <= 0 {
        return None;
    }
    let idx = (num - 1) as usize;
    let letter_offset = (idx % 26) as u8;
    let repeat = (idx / 26) + 1;
    let base = if uppercase { b'A' } else { b'a' };
    let ch = (base + letter_offset) as char;
    Some(std::iter::repeat_n(ch, repeat).collect())
}

#[cfg(test)]
mod page_label_tests {
    use super::*;
    use lopdf::dictionary;

    #[test]
    fn resolves_page_labels_roman_prefix_and_decimal() {
        let mut state = DocumentState::new_blank(612.0, 792.0).unwrap();
        for i in 1..6 {
            state.insert_blank_page(i, 612.0, 792.0).unwrap();
        }
        let nums = vec![
            Object::Integer(0),
            Object::Dictionary(dictionary! { "S" => "r" }),
            Object::Integer(2),
            Object::Dictionary(dictionary! { "P" => Object::string_literal("A-"), "S" => "D", "St" => 1 }),
            Object::Integer(4),
            Object::Dictionary(dictionary! { "S" => "A", "St" => 1 }),
        ];
        let labels_id = state.doc.add_object(dictionary! { "Nums" => nums });
        let root_id = state.doc.trailer.get(b"Root").unwrap().as_reference().unwrap();
        state
            .doc
            .get_dictionary_mut(root_id)
            .unwrap()
            .set("PageLabels", labels_id);

        let labels = state.get_page_labels();
        assert_eq!(
            labels,
            vec![
                Some("i".to_string()),
                Some("ii".to_string()),
                Some("A-1".to_string()),
                Some("A-2".to_string()),
                Some("A".to_string()),
                Some("B".to_string()),
            ]
        );
    }
}
