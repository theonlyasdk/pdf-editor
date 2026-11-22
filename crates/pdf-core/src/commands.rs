use crate::document::{CoreError, DocumentState};
use crate::types::{AnnotationDto, PageBox};
use lopdf::{Dictionary, ObjectId};

pub trait DocumentCommand: Send + Sync {
    fn execute(&mut self, doc: &mut DocumentState) -> Result<(), CoreError>;
    fn undo(&mut self, doc: &mut DocumentState) -> Result<(), CoreError>;
    fn description(&self) -> String;
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
        mut command: Box<dyn DocumentCommand>,
    ) -> Result<(), CoreError> {
        command.execute(doc)?;
        self.undo_stack.push(command);
        self.redo_stack.clear();
        self.revision_id += 1;
        Ok(())
    }

    pub fn undo(&mut self, doc: &mut DocumentState) -> Result<Option<String>, CoreError> {
        if let Some(mut cmd) = self.undo_stack.pop() {
            cmd.undo(doc)?;
            let desc = cmd.description();
            self.redo_stack.push(cmd);
            self.revision_id += 1;
            Ok(Some(desc))
        } else {
            Ok(None)
        }
    }

    pub fn redo(&mut self, doc: &mut DocumentState) -> Result<Option<String>, CoreError> {
        if let Some(mut cmd) = self.redo_stack.pop() {
            cmd.execute(doc)?;
            let desc = cmd.description();
            self.undo_stack.push(cmd);
            self.revision_id += 1;
            Ok(Some(desc))
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
}
