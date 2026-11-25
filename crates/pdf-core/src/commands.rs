use crate::document::{CoreError, DocumentState};
use crate::types::{AnnotationDto, DocumentMetadataUpdate, PageBox};
use lopdf::{Dictionary, Object, ObjectId};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommandRenderEffect {
    None,
    Pages(Vec<usize>),
    Structural,
}

pub trait DocumentCommand: Send + Sync {
    fn execute(&mut self, doc: &mut DocumentState) -> Result<(), CoreError>;
    fn undo(&mut self, doc: &mut DocumentState) -> Result<(), CoreError>;
    fn description(&self) -> String;

    fn render_effect(&self) -> CommandRenderEffect {
        CommandRenderEffect::Structural
    }
}

pub struct CommandManager {
    undo_stack: Vec<Box<dyn DocumentCommand>>,
    redo_stack: Vec<Box<dyn DocumentCommand>>,
    saved_index: Option<usize>,
    revision_id: u64,
}

impl CommandManager {
    pub fn new() -> Self {
        Self {
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
            saved_index: Some(0),
            revision_id: 1,
        }
    }

    pub fn execute(
        &mut self,
        doc: &mut DocumentState,
        command: Box<dyn DocumentCommand>,
    ) -> Result<(), CoreError> {
        self.execute_tracked(doc, command).map(|_| ())
    }

    pub fn execute_tracked(
        &mut self,
        doc: &mut DocumentState,
        mut command: Box<dyn DocumentCommand>,
    ) -> Result<CommandRenderEffect, CoreError> {
        let effect = command.render_effect();
        command.execute(doc)?;
        self.undo_stack.push(command);
        self.redo_stack.clear();
        self.revision_id += 1;
        Ok(effect)
    }

    pub fn undo(&mut self, doc: &mut DocumentState) -> Result<Option<String>, CoreError> {
        self.undo_tracked(doc).map(|opt| opt.map(|(desc, _)| desc))
    }

    pub fn undo_tracked(
        &mut self,
        doc: &mut DocumentState,
    ) -> Result<Option<(String, CommandRenderEffect)>, CoreError> {
        if let Some(mut cmd) = self.undo_stack.pop() {
            let effect = cmd.render_effect();
            cmd.undo(doc)?;
            let desc = cmd.description();
            self.redo_stack.push(cmd);
            self.revision_id += 1;
            Ok(Some((desc, effect)))
        } else {
            Ok(None)
        }
    }

    pub fn redo(&mut self, doc: &mut DocumentState) -> Result<Option<String>, CoreError> {
        self.redo_tracked(doc).map(|opt| opt.map(|(desc, _)| desc))
    }

    pub fn redo_tracked(
        &mut self,
        doc: &mut DocumentState,
    ) -> Result<Option<(String, CommandRenderEffect)>, CoreError> {
        if let Some(mut cmd) = self.redo_stack.pop() {
            let effect = cmd.render_effect();
            cmd.execute(doc)?;
            let desc = cmd.description();
            self.undo_stack.push(cmd);
            self.revision_id += 1;
            Ok(Some((desc, effect)))
        } else {
            Ok(None)
        }
    }

    pub fn can_undo(&self) -> bool {
        !self.undo_stack.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo_stack.is_empty()
    }

    pub fn is_dirty(&self) -> bool {
        match self.saved_index {
            Some(idx) => self.undo_stack.len() != idx,
            None => true,
        }
    }

    pub fn mark_saved(&mut self) {
        self.saved_index = Some(self.undo_stack.len());
    }

    pub fn revision_id(&self) -> u64 {
        self.revision_id
    }

    pub fn bump_revision_dirty(&mut self) {
        self.saved_index = None;
        self.revision_id += 1;
    }

    pub fn history(&self) -> Vec<String> {
        self.undo_stack.iter().map(|c| c.description()).collect()
    }
}

impl Default for CommandManager {
    fn default() -> Self {
        Self::new()
    }
}

// Concrete Invertible Commands:

pub struct ReorderPagesCommand {
    pub previous_ids: Vec<ObjectId>,
    pub new_ids: Vec<ObjectId>,
}

impl DocumentCommand for ReorderPagesCommand {
    fn execute(&mut self, doc: &mut DocumentState) -> Result<(), CoreError> {
        doc.apply_page_ids(&self.new_ids)
    }

    fn undo(&mut self, doc: &mut DocumentState) -> Result<(), CoreError> {
        doc.apply_page_ids(&self.previous_ids)
    }

    fn description(&self) -> String {
        "Reorder Pages".to_string()
    }
}

pub struct RotatePagesCommand {
    pub pages: Vec<usize>,
    pub delta_deg: i32,
}

impl DocumentCommand for RotatePagesCommand {
    fn execute(&mut self, doc: &mut DocumentState) -> Result<(), CoreError> {
        doc.rotate_pages(&self.pages, self.delta_deg)
    }

    fn undo(&mut self, doc: &mut DocumentState) -> Result<(), CoreError> {
        doc.rotate_pages(&self.pages, -self.delta_deg)
    }

    fn description(&self) -> String {
        format!("Rotate Pages by {}°", self.delta_deg)
    }

    fn render_effect(&self) -> CommandRenderEffect {
        CommandRenderEffect::Pages(self.pages.clone())
    }
}

pub struct CropPagesCommand {
    pub pages: Vec<usize>,
    pub previous_boxes: Vec<Option<PageBox>>,
    pub new_boxes: Vec<Option<PageBox>>,
}

impl DocumentCommand for CropPagesCommand {
    fn execute(&mut self, doc: &mut DocumentState) -> Result<(), CoreError> {
        for (&page, &box_) in self.pages.iter().zip(&self.new_boxes) {
            doc.set_crop_box(&[page], box_)?;
        }
        Ok(())
    }

    fn undo(&mut self, doc: &mut DocumentState) -> Result<(), CoreError> {
        for (idx, &page) in self.pages.iter().enumerate() {
            doc.set_crop_box(&[page], self.previous_boxes[idx])?;
        }
        Ok(())
    }

    fn description(&self) -> String {
        "Crop Pages".to_string()
    }

    fn render_effect(&self) -> CommandRenderEffect {
        CommandRenderEffect::Pages(self.pages.clone())
    }
}

pub struct DeletePagesCommand {
    pub deleted_positions: Vec<usize>,
    pub stored_pages: Vec<(ObjectId, Dictionary)>,
    pub previous_page_ids: Vec<ObjectId>,
}

impl DocumentCommand for DeletePagesCommand {
    fn execute(&mut self, doc: &mut DocumentState) -> Result<(), CoreError> {
        doc.delete_pages(&self.deleted_positions)
    }

    fn undo(&mut self, doc: &mut DocumentState) -> Result<(), CoreError> {
        // Re-insert objects into document and restore page_ids
        for (id, dict) in &self.stored_pages {
            doc.doc
                .objects
                .insert(*id, lopdf::Object::Dictionary(dict.clone()));
        }
        let root_id = doc.doc.trailer.get(b"Root")?.as_reference()?;
        let root_dict = doc.doc.get_dictionary(root_id)?;
        let pages_id = root_dict.get(b"Pages")?.as_reference()?;
        let pages_node = doc.doc.get_dictionary_mut(pages_id)?;
        let kids_vec: Vec<lopdf::Object> = self
            .previous_page_ids
            .iter()
            .map(|&id| lopdf::Object::Reference(id))
            .collect();
        pages_node.set("Kids", kids_vec);
        pages_node.set("Count", self.previous_page_ids.len() as i64);
        doc.rebuild_page_ids()?;
        Ok(())
    }

    fn description(&self) -> String {
        format!("Delete {} Page(s)", self.deleted_positions.len())
    }
}

pub struct InsertBlankPageCommand {
    pub at_index: usize,
    pub width: f64,
    pub height: f64,
}

impl DocumentCommand for InsertBlankPageCommand {
    fn execute(&mut self, doc: &mut DocumentState) -> Result<(), CoreError> {
        doc.insert_blank_page(self.at_index, self.width, self.height)
    }

    fn undo(&mut self, doc: &mut DocumentState) -> Result<(), CoreError> {
        doc.delete_pages(&[self.at_index])
    }

    fn description(&self) -> String {
        format!("Insert Blank Page at {}", self.at_index + 1)
    }
}

pub struct AddAnnotationCommand {
    pub page_index: usize,
    pub annotation: AnnotationDto,
}

impl DocumentCommand for AddAnnotationCommand {
    fn execute(&mut self, doc: &mut DocumentState) -> Result<(), CoreError> {
        let list = doc.annotations.entry(self.page_index).or_default();
        list.push(self.annotation.clone());
        Ok(())
    }

    fn undo(&mut self, doc: &mut DocumentState) -> Result<(), CoreError> {
        if let Some(list) = doc.annotations.get_mut(&self.page_index) {
            list.retain(|a| a.id != self.annotation.id);
        }
        Ok(())
    }

    fn description(&self) -> String {
        format!("Add {:?} Annotation", self.annotation.annot_type)
    }

    fn render_effect(&self) -> CommandRenderEffect {
        CommandRenderEffect::Pages(vec![self.page_index])
    }
}

pub struct DeleteAnnotationCommand {
    pub page_index: usize,
    pub snapshot: AnnotationDto,
}

impl DocumentCommand for DeleteAnnotationCommand {
    fn execute(&mut self, doc: &mut DocumentState) -> Result<(), CoreError> {
        if let Some(list) = doc.annotations.get_mut(&self.page_index) {
            list.retain(|a| a.id != self.snapshot.id);
        }
        Ok(())
    }

    fn undo(&mut self, doc: &mut DocumentState) -> Result<(), CoreError> {
        let list = doc.annotations.entry(self.page_index).or_default();
        list.push(self.snapshot.clone());
        Ok(())
    }

    fn description(&self) -> String {
        "Delete Annotation".to_string()
    }

    fn render_effect(&self) -> CommandRenderEffect {
        CommandRenderEffect::Pages(vec![self.page_index])
    }
}

pub struct ModifyAnnotationCommand {
    pub page_index: usize,
    pub old_state: AnnotationDto,
    pub new_state: AnnotationDto,
}

impl DocumentCommand for ModifyAnnotationCommand {
    fn execute(&mut self, doc: &mut DocumentState) -> Result<(), CoreError> {
        if let Some(list) = doc.annotations.get_mut(&self.page_index) {
            if let Some(item) = list.iter_mut().find(|a| a.id == self.new_state.id) {
                *item = self.new_state.clone();
            }
        }
        Ok(())
    }

    fn undo(&mut self, doc: &mut DocumentState) -> Result<(), CoreError> {
        if let Some(list) = doc.annotations.get_mut(&self.page_index) {
            if let Some(item) = list.iter_mut().find(|a| a.id == self.old_state.id) {
                *item = self.old_state.clone();
            }
        }
        Ok(())
    }

    fn description(&self) -> String {
        "Modify Annotation".to_string()
    }

    fn render_effect(&self) -> CommandRenderEffect {
        CommandRenderEffect::Pages(vec![self.page_index])
    }
}

pub struct UpdateMetadataCommand {
    pub update: DocumentMetadataUpdate,
    previous_info_ref: Option<Object>,
    previous_info_dict: Option<(ObjectId, Dictionary)>,
    created_info_id: Option<ObjectId>,
}

impl UpdateMetadataCommand {
    pub fn new(update: DocumentMetadataUpdate) -> Self {
        Self {
            update,
            previous_info_ref: None,
            previous_info_dict: None,
            created_info_id: None,
        }
    }
}

impl DocumentCommand for UpdateMetadataCommand {
    fn execute(&mut self, doc: &mut DocumentState) -> Result<(), CoreError> {
        self.previous_info_ref = doc.doc.trailer.get(b"Info").ok().cloned();
        self.previous_info_dict = None;
        self.created_info_id = None;

        if let Some(Object::Reference(info_id)) = self.previous_info_ref {
            if let Ok(dict) = doc.doc.get_dictionary(info_id) {
                self.previous_info_dict = Some((info_id, dict.clone()));
            }
        }

        doc.update_metadata(&self.update)?;

        if self.previous_info_dict.is_none() {
            if let Ok(Object::Reference(new_id)) = doc.doc.trailer.get(b"Info") {
                self.created_info_id = Some(*new_id);
            }
        }
        Ok(())
    }

    fn undo(&mut self, doc: &mut DocumentState) -> Result<(), CoreError> {
        if let Some((info_id, dict)) = self.previous_info_dict.take() {
            doc.doc.objects.insert(info_id, Object::Dictionary(dict));
        }
        if let Some(created_id) = self.created_info_id.take() {
            doc.doc.objects.remove(&created_id);
        }
        match self.previous_info_ref.take() {
            Some(prev) => doc.doc.trailer.set("Info", prev),
            None => {
                doc.doc.trailer.remove(b"Info");
            }
        }
        Ok(())
    }

    fn description(&self) -> String {
        "Update Metadata".to_string()
    }

    fn render_effect(&self) -> CommandRenderEffect {
        CommandRenderEffect::None
    }
}

pub struct StripMetadataCommand {
    previous_info_ref: Option<Object>,
    previous_catalog_entries: Vec<(Vec<u8>, Object)>,
    previous_page_entries: Vec<(ObjectId, Vec<(Vec<u8>, Object)>)>,
    stashed_objects: Vec<(ObjectId, Object)>,
}

impl StripMetadataCommand {
    pub fn new() -> Self {
        Self {
            previous_info_ref: None,
            previous_catalog_entries: Vec::new(),
            previous_page_entries: Vec::new(),
            stashed_objects: Vec::new(),
        }
    }
}

impl Default for StripMetadataCommand {
    fn default() -> Self {
        Self::new()
    }
}

fn collect_reachable_objects(doc: &lopdf::Document, obj: &Object, seen: &mut HashSet<ObjectId>) {
    match obj {
        Object::Reference(id) => {
            if seen.insert(*id) {
                if let Ok(target) = doc.get_object(*id) {
                    collect_reachable_objects(doc, target, seen);
                }
            }
        }
        Object::Array(arr) => {
            for item in arr {
                collect_reachable_objects(doc, item, seen);
            }
        }
        Object::Dictionary(dict) => {
            for (_, v) in dict.iter() {
                collect_reachable_objects(doc, v, seen);
            }
        }
        Object::Stream(stream) => {
            for (_, v) in stream.dict.iter() {
                collect_reachable_objects(doc, v, seen);
            }
        }
        _ => {}
    }
}

impl DocumentCommand for StripMetadataCommand {
    fn execute(&mut self, doc: &mut DocumentState) -> Result<(), CoreError> {
        self.previous_info_ref = doc.doc.trailer.get(b"Info").ok().cloned();
        self.previous_catalog_entries.clear();
        self.previous_page_entries.clear();
        self.stashed_objects.clear();

        let mut candidate_ids = HashSet::new();
        if let Some(ref info_obj) = self.previous_info_ref {
            collect_reachable_objects(&doc.doc, info_obj, &mut candidate_ids);
        }

        if let Ok(root_id) = doc.doc.trailer.get(b"Root").and_then(|o| o.as_reference()) {
            if let Ok(catalog) = doc.doc.get_dictionary(root_id) {
                for key in [b"Metadata".as_slice(), b"PieceInfo", b"SpiderInfo"] {
                    if let Ok(val) = catalog.get(key) {
                        collect_reachable_objects(&doc.doc, val, &mut candidate_ids);
                        self.previous_catalog_entries
                            .push((key.to_vec(), val.clone()));
                    }
                }
            }
        }

        for idx in 0..doc.page_count() {
            if let Ok(pid) = doc.get_page_id(idx) {
                if let Ok(pdict) = doc.doc.get_dictionary(pid) {
                    let mut page_entries = Vec::new();
                    for key in [b"Metadata".as_slice(), b"PieceInfo"] {
                        if let Ok(val) = pdict.get(key) {
                            collect_reachable_objects(&doc.doc, val, &mut candidate_ids);
                            page_entries.push((key.to_vec(), val.clone()));
                        }
                    }
                    if !page_entries.is_empty() {
                        self.previous_page_entries.push((pid, page_entries));
                    }
                }
            }
        }

        let candidate_snapshot: Vec<(ObjectId, Object)> = candidate_ids
            .into_iter()
            .filter_map(|id| doc.doc.objects.get(&id).map(|obj| (id, obj.clone())))
            .collect();

        doc.strip_metadata()?;

        for (id, obj) in candidate_snapshot {
            if !doc.doc.objects.contains_key(&id) {
                self.stashed_objects.push((id, obj));
            }
        }
        Ok(())
    }

    fn undo(&mut self, doc: &mut DocumentState) -> Result<(), CoreError> {
        for (id, obj) in self.stashed_objects.drain(..) {
            doc.doc.objects.insert(id, obj);
        }
        if let Some(info_ref) = self.previous_info_ref.take() {
            doc.doc.trailer.set("Info", info_ref);
        }
        if let Ok(root_id) = doc.doc.trailer.get(b"Root").and_then(|o| o.as_reference()) {
            if let Ok(catalog) = doc.doc.get_dictionary_mut(root_id) {
                for (key, val) in self.previous_catalog_entries.drain(..) {
                    catalog.set(key, val);
                }
            }
        }
        for (pid, entries) in self.previous_page_entries.drain(..) {
            if let Ok(pdict) = doc.doc.get_dictionary_mut(pid) {
                for (key, val) in entries {
                    pdict.set(key, val);
                }
            }
        }
        Ok(())
    }

    fn description(&self) -> String {
        "Strip Metadata".to_string()
    }

    fn render_effect(&self) -> CommandRenderEffect {
        CommandRenderEffect::None
    }
}

pub struct MergePdfCommand {
    pub paths: Vec<String>,
    pub insert_at: Option<usize>,
    previous_page_ids: Vec<ObjectId>,
    previous_annotations: HashMap<usize, Vec<AnnotationDto>>,
    new_page_ids: Vec<ObjectId>,
    new_annotations: HashMap<usize, Vec<AnnotationDto>>,
    added_object_ids: Vec<ObjectId>,
    stashed_objects: Vec<(ObjectId, Object)>,
    initialized: bool,
}

impl MergePdfCommand {
    pub fn new(paths: Vec<String>, insert_at: Option<usize>) -> Self {
        Self {
            paths,
            insert_at,
            previous_page_ids: Vec::new(),
            previous_annotations: HashMap::new(),
            new_page_ids: Vec::new(),
            new_annotations: HashMap::new(),
            added_object_ids: Vec::new(),
            stashed_objects: Vec::new(),
            initialized: false,
        }
    }
}

impl DocumentCommand for MergePdfCommand {
    fn execute(&mut self, doc: &mut DocumentState) -> Result<(), CoreError> {
        if !self.initialized {
            self.previous_page_ids = (0..doc.page_count())
                .map(|i| doc.get_page_id(i))
                .collect::<Result<Vec<_>, _>>()?;
            self.previous_annotations = doc.annotations.clone();

            let (added_ids, _) = doc.merge_pdfs(&self.paths, self.insert_at)?;
            self.added_object_ids = added_ids;
            self.new_page_ids = (0..doc.page_count())
                .map(|i| doc.get_page_id(i))
                .collect::<Result<Vec<_>, _>>()?;
            self.new_annotations = doc.annotations.clone();
            self.initialized = true;
            return Ok(());
        }

        for (id, obj) in self.stashed_objects.drain(..) {
            doc.doc.objects.insert(id, obj);
        }
        doc.apply_page_ids(&self.new_page_ids)?;
        doc.annotations = self.new_annotations.clone();
        Ok(())
    }

    fn undo(&mut self, doc: &mut DocumentState) -> Result<(), CoreError> {
        doc.apply_page_ids(&self.previous_page_ids)?;
        doc.annotations = self.previous_annotations.clone();
        self.stashed_objects.clear();
        for &id in &self.added_object_ids {
            if let Some(obj) = doc.doc.objects.remove(&id) {
                self.stashed_objects.push((id, obj));
            }
        }
        Ok(())
    }

    fn description(&self) -> String {
        format!("Merge {} PDF(s)", self.paths.len())
    }
}
