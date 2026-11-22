use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use parking_lot::Mutex;
use pdf_core::commands::*;
use pdf_core::document::{CoreError, DocumentState};
use pdf_core::persistence::safe_save;
use pdf_core::range_parser::parse_page_range;
use pdf_core::redaction::{apply_cover_erase, apply_true_redact};
use pdf_core::renderer::PdfRenderer;
use pdf_core::types::*;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;

#[derive(Serialize, Deserialize, Clone)]
pub struct DocumentDto {
    pub file_path: Option<String>,
    pub file_name: String,
    pub page_count: usize,
    pub pages: Vec<PageInfo>,
    pub metadata: DocumentMetadata,
    pub can_undo: bool,
    pub can_redo: bool,
    pub is_dirty: bool,
    pub revision_id: u64,
}

pub struct AppState {
    pub doc: Option<DocumentState>,
    pub current_path: Option<PathBuf>,
    pub cmd_mgr: CommandManager,
    pub renderer: Option<PdfRenderer>,
    render_source: Option<(u64, Vec<u8>)>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            doc: None,
            current_path: None,
            cmd_mgr: CommandManager::new(),
            renderer: PdfRenderer::new().ok(),
            render_source: None,
        }
    }

    fn invalidate_render_source(&mut self) {
        self.render_source = None;
        if let Some(renderer) = &self.renderer {
            renderer.clear_cache();
        }
    }

    pub fn execute_cmd(&mut self, cmd: Box<dyn DocumentCommand>) -> Result<(), CoreError> {
        let doc = self
            .doc
            .as_mut()
            .ok_or_else(|| CoreError::InvalidOperation("No document open".into()))?;
        self.cmd_mgr.execute(doc, cmd)
    }

    pub fn undo_cmd(&mut self) -> Result<Option<String>, CoreError> {
        let doc = self
            .doc
            .as_mut()
            .ok_or_else(|| CoreError::InvalidOperation("No document open".into()))?;
        self.cmd_mgr.undo(doc)
    }

    pub fn redo_cmd(&mut self) -> Result<Option<String>, CoreError> {
        let doc = self
            .doc
            .as_mut()
            .ok_or_else(|| CoreError::InvalidOperation("No document open".into()))?;
        self.cmd_mgr.redo(doc)
    }

    pub fn to_dto(&self) -> Result<DocumentDto, String> {
        let doc = self.doc.as_ref().ok_or("No document open")?;
        let mut pages = Vec::new();
        for i in 0..doc.page_count() {
            pages.push(doc.get_page_info(i).map_err(|e| e.to_string())?);
        }

        let file_name = self
            .current_path
            .as_ref()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .unwrap_or("Untitled.pdf")
            .to_string();

        let path_str = self
            .current_path
            .as_ref()
            .map(|p| p.to_string_lossy().to_string());

        Ok(DocumentDto {
            file_path: path_str,
            file_name,
            page_count: pages.len(),
            pages,
            metadata: doc.get_metadata(0),
            can_undo: self.cmd_mgr.can_undo(),
            can_redo: self.cmd_mgr.can_redo(),
            is_dirty: self.cmd_mgr.is_dirty(),
            revision_id: self.cmd_mgr.revision_id(),
        })
    }
}

pub type SharedState = Arc<Mutex<AppState>>;

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

#[tauri::command]
pub async fn open_document(
    path: String,
    _password: Option<String>,
    state: State<'_, SharedState>,
) -> Result<DocumentDto, String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        if !p.exists() {
            return Err(format!("File does not exist: {}", path));
        }

        let bytes = std::fs::read(&p).map_err(|e| e.to_string())?;
        let doc = DocumentState::from_bytes(&bytes).map_err(|e| e.to_string())?;
        let metadata = doc.get_metadata(bytes.len() as u64);

        let mut pages = Vec::new();
        for i in 0..doc.page_count() {
            pages.push(doc.get_page_info(i).map_err(|e| e.to_string())?);
        }

        let file_name = p
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("document.pdf")
            .to_string();

        let mut lock = state.lock();
        lock.doc = Some(doc);
        lock.current_path = Some(p);
        lock.cmd_mgr = CommandManager::new();

        if lock.renderer.is_none() {
            lock.renderer = PdfRenderer::new().ok();
        }

        let revision = lock.cmd_mgr.revision_id();
        lock.render_source = Some((revision, bytes));
        if let Some(renderer) = &lock.renderer {
            renderer.clear_cache();
        }

        Ok(DocumentDto {
            file_path: Some(path),
            file_name,
            page_count: pages.len(),
            pages,
            metadata,
            can_undo: false,
            can_redo: false,
            is_dirty: false,
            revision_id: lock.cmd_mgr.revision_id(),
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn new_document(state: State<'_, SharedState>) -> Result<DocumentDto, String> {
    let doc = DocumentState::new_blank(612.0, 792.0).map_err(|e| e.to_string())?;
    let pages = vec![doc.get_page_info(0).map_err(|e| e.to_string())?];

    let mut lock = state.lock();
    lock.doc = Some(doc);
    lock.current_path = None;
    lock.cmd_mgr = CommandManager::new();

    if lock.renderer.is_none() {
        lock.renderer = PdfRenderer::new().ok();
    }

    lock.invalidate_render_source();

    Ok(DocumentDto {
        file_path: None,
        file_name: "Untitled.pdf".to_string(),
        page_count: 1,
        pages,
        metadata: DocumentMetadata {
            page_count: 1,
            ..Default::default()
        },
        can_undo: false,
        can_redo: false,
        is_dirty: false,
        revision_id: lock.cmd_mgr.revision_id(),
    })
}

#[tauri::command]
pub async fn render_page(
    page_index: usize,
    target_width: u32,
    state: State<'_, SharedState>,
) -> Result<String, String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let mut lock = state.lock();
        let revision = lock.cmd_mgr.revision_id();
        if lock.render_source.as_ref().map(|(id, _)| *id) != Some(revision) {
            let mut doc = lock.doc.as_ref().ok_or("No document open")?.clone();
            let bytes = doc.to_bytes().map_err(|e| e.to_string())?;
            lock.render_source = Some((revision, bytes));
        }
        let (_, bytes) = lock.render_source.as_ref().ok_or("No document open")?;
        let renderer = lock.renderer.as_ref().ok_or("Renderer not initialized")?;
        let png = renderer
            .render_page_cached(bytes, page_index, target_width, revision, None)
            .map_err(|e| e.to_string())?;
        Ok(format!("data:image/png;base64,{}", BASE64.encode(png)))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn reorder_pages(
    new_order: Vec<usize>,
    state: State<'_, SharedState>,
) -> Result<DocumentDto, String> {
    let mut lock = state.lock();
    let (previous_ids, new_ids) = {
        let doc = lock.doc.as_ref().ok_or("No doc")?;
        let prev: Vec<_> = (0..doc.page_count())
            .map(|i| doc.get_page_id(i).unwrap())
            .collect();
        let next: Vec<_> = new_order.iter().map(|&idx| prev[idx]).collect();
        (prev, next)
    };
    let cmd = Box::new(ReorderPagesCommand {
        previous_ids,
        new_ids,
    });
    lock.execute_cmd(cmd).map_err(|e| e.to_string())?;
    lock.to_dto()
}

#[tauri::command]
pub fn rotate_pages(
    pages: Vec<usize>,
    delta_deg: i32,
    state: State<'_, SharedState>,
) -> Result<DocumentDto, String> {
    let mut lock = state.lock();
    let cmd = Box::new(RotatePagesCommand { pages, delta_deg });
    lock.execute_cmd(cmd).map_err(|e| e.to_string())?;
    lock.to_dto()
}

#[tauri::command]
pub fn crop_pages(
    pages: Vec<usize>,
    crop_box: Option<PageBox>,
    state: State<'_, SharedState>,
) -> Result<DocumentDto, String> {
    let mut lock = state.lock();
    let doc = lock.doc.as_ref().ok_or("No document open")?;
    let mut previous_boxes = Vec::with_capacity(pages.len());
    let mut new_boxes = Vec::with_capacity(pages.len());
    for &index in &pages {
        let page = doc
            .get_page_info(index)
            .map_err(|error| error.to_string())?;
        previous_boxes.push(page.crop_box);
        let new_box = crop_box
            .map(|crop| {
                page.viewport_crop(crop)
                    .ok_or_else(|| format!("Crop is outside page {}", index + 1))
            })
            .transpose()?;
        new_boxes.push(new_box);
    }
    let cmd = Box::new(CropPagesCommand {
        pages,
        previous_boxes,
        new_boxes,
    });
    lock.execute_cmd(cmd).map_err(|e| e.to_string())?;
    lock.to_dto()
}

#[tauri::command]
pub fn delete_pages(
    pages: Vec<usize>,
    state: State<'_, SharedState>,
) -> Result<DocumentDto, String> {
    let mut lock = state.lock();
    let (stored_pages, previous_page_ids) = {
        let doc = lock.doc.as_ref().ok_or("No doc")?;
        let mut list = Vec::new();
        let prev_ids: Vec<_> = (0..doc.page_count())
            .map(|i| doc.get_page_id(i).unwrap())
            .collect();
        for &p in &pages {
            let id = doc.get_page_id(p).map_err(|e| e.to_string())?;
            let dict = doc
                .doc
                .get_dictionary(id)
                .map_err(|e| e.to_string())?
                .clone();
            list.push((id, dict));
        }
        (list, prev_ids)
    };

    let cmd = Box::new(DeletePagesCommand {
        deleted_positions: pages,
        stored_pages,
        previous_page_ids,
    });
    lock.execute_cmd(cmd).map_err(|e| e.to_string())?;
    lock.to_dto()
}

#[tauri::command]
pub fn duplicate_pages(
    pages: Vec<usize>,
    state: State<'_, SharedState>,
) -> Result<DocumentDto, String> {
    let mut lock = state.lock();
    let doc = lock.doc.as_mut().ok_or("No document open")?;
    doc.duplicate_pages(&pages).map_err(|e| e.to_string())?;
    lock.invalidate_render_source();
    lock.to_dto()
}

#[tauri::command]
pub fn insert_blank_page(
    at_index: usize,
    width: f64,
    height: f64,
    state: State<'_, SharedState>,
) -> Result<DocumentDto, String> {
    let mut lock = state.lock();
    let cmd = Box::new(InsertBlankPageCommand {
        at_index,
        width,
        height,
    });
    lock.execute_cmd(cmd).map_err(|e| e.to_string())?;
    lock.to_dto()
}

#[tauri::command]
pub fn add_annotation(
    annotation: AnnotationDto,
    state: State<'_, SharedState>,
) -> Result<DocumentDto, String> {
    let mut lock = state.lock();
    let page_index = annotation.page_index;
    let cmd = Box::new(AddAnnotationCommand {
        page_index,
        annotation,
    });
    lock.execute_cmd(cmd).map_err(|e| e.to_string())?;
    lock.to_dto()
}

#[tauri::command]
pub fn delete_annotation(
    page_index: usize,
    annotation_id: String,
    state: State<'_, SharedState>,
) -> Result<DocumentDto, String> {
    let mut lock = state.lock();
    let snapshot = {
        let doc = lock.doc.as_ref().ok_or("No doc")?;
        doc.annotations
            .get(&page_index)
            .and_then(|list| list.iter().find(|a| a.id == annotation_id).cloned())
            .ok_or("Annotation not found")?
    };
    let cmd = Box::new(DeleteAnnotationCommand {
        page_index,
        snapshot,
    });
    lock.execute_cmd(cmd).map_err(|e| e.to_string())?;
    lock.to_dto()
}

#[tauri::command]
pub fn cover_erase(
    page_index: usize,
    rect: PageBox,
    color: String,
    state: State<'_, SharedState>,
) -> Result<DocumentDto, String> {
    let mut lock = state.lock();
    let doc = lock.doc.as_mut().ok_or("No document open")?;
    apply_cover_erase(doc, page_index, rect, &color).map_err(|e| e.to_string())?;
    lock.invalidate_render_source();
    lock.to_dto()
}

#[tauri::command]
pub fn true_redact(
    page_index: usize,
    rect: PageBox,
    text: Option<String>,
    state: State<'_, SharedState>,
) -> Result<DocumentDto, String> {
    let mut lock = state.lock();
    let doc = lock.doc.as_mut().ok_or("No document open")?;
    apply_true_redact(doc, page_index, rect, text.as_deref()).map_err(|e| e.to_string())?;
    lock.invalidate_render_source();
    lock.to_dto()
}

#[tauri::command]
pub fn undo(state: State<'_, SharedState>) -> Result<DocumentDto, String> {
    let mut lock = state.lock();
    lock.undo_cmd().map_err(|e| e.to_string())?;
    lock.to_dto()
}

#[tauri::command]
pub fn redo(state: State<'_, SharedState>) -> Result<DocumentDto, String> {
    let mut lock = state.lock();
    lock.redo_cmd().map_err(|e| e.to_string())?;
    lock.to_dto()
}

#[tauri::command]
pub fn save_document(make_backup: bool, state: State<'_, SharedState>) -> Result<(), String> {
    let mut lock = state.lock();
    let path = lock
        .current_path
        .clone()
        .ok_or("No save path specified, please use Save As")?;

    let doc = lock.doc.as_mut().ok_or("No document open")?;
    pdf_core::annotations::commit_annotations_to_pdf(doc).map_err(|e| e.to_string())?;
    safe_save(doc, &path, make_backup).map_err(|e| e.to_string())?;
    lock.cmd_mgr.mark_saved();
    Ok(())
}

#[tauri::command]
pub fn save_document_as(
    target_path: String,
    make_backup: bool,
    state: State<'_, SharedState>,
) -> Result<(), String> {
    let p = PathBuf::from(&target_path);
    let mut lock = state.lock();
    let doc = lock.doc.as_mut().ok_or("No document open")?;
    pdf_core::annotations::commit_annotations_to_pdf(doc).map_err(|e| e.to_string())?;
    safe_save(doc, &p, make_backup).map_err(|e| e.to_string())?;
    lock.current_path = Some(p);
    lock.cmd_mgr.mark_saved();
    Ok(())
}

#[tauri::command]
pub fn evaluate_range(expression: String, total_pages: usize) -> Result<Vec<usize>, String> {
    parse_page_range(&expression, total_pages).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn search_document(
    query: String,
    case_sensitive: bool,
    state: State<'_, SharedState>,
) -> Result<Vec<SearchResult>, String> {
    let lock = state.lock();
    let doc = lock.doc.as_ref().ok_or("No document open")?;
    let renderer = lock.renderer.as_ref().ok_or("Renderer not ready")?;

    let mut clone_doc = doc.clone();
    let bytes = clone_doc.to_bytes().map_err(|e| e.to_string())?;
    renderer
        .search_document(&bytes, &query, case_sensitive, None)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_document_state(state: State<'_, SharedState>) -> Result<DocumentDto, String> {
    let lock = state.lock();
    lock.to_dto()
}
