use crate::types::*;
use lopdf::{dictionary, Document, Object, ObjectId};
use std::collections::HashMap;
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
        })
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
                    if let Ok(t) = info_dict.get(b"Title") {
                        meta.title = t
                            .as_str()
                            .map(|s| String::from_utf8_lossy(s).into_owned())
                            .ok();
                    }
                    if let Ok(a) = info_dict.get(b"Author") {
                        meta.author = a
                            .as_str()
                            .map(|s| String::from_utf8_lossy(s).into_owned())
                            .ok();
                    }
                    if let Ok(s) = info_dict.get(b"Subject") {
                        meta.subject = s
                            .as_str()
                            .map(|s| String::from_utf8_lossy(s).into_owned())
                            .ok();
                    }
                    if let Ok(k) = info_dict.get(b"Keywords") {
                        meta.keywords = k
                            .as_str()
                            .map(|s| String::from_utf8_lossy(s).into_owned())
                            .ok();
                    }
                    if let Ok(c) = info_dict.get(b"Creator") {
                        meta.creator = c
                            .as_str()
                            .map(|s| String::from_utf8_lossy(s).into_owned())
                            .ok();
                    }
                    if let Ok(p) = info_dict.get(b"Producer") {
                        meta.producer = p
                            .as_str()
                            .map(|s| String::from_utf8_lossy(s).into_owned())
                            .ok();
                    }
                }
            }
        }
        meta
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
