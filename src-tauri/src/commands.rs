use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use parking_lot::Mutex;
use pdf_core::batch_overlay::BatchOverlayCommand;
use pdf_core::commands::*;
use pdf_core::document::{CoreError, DocumentState};
use pdf_core::persistence::safe_save;
use pdf_core::range_parser::parse_page_range;
use pdf_core::redaction::{apply_area_redactions as core_apply_area_redactions, apply_cover_erase, apply_true_redact};
use pdf_core::renderer::PdfRenderer;
use pdf_core::types::*;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::State;

static IMAGE_ANNOT_COUNTER: AtomicU64 = AtomicU64::new(1);

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
    pub annotations: Vec<AnnotationDto>,
}

pub struct AppState {
    pub doc: Option<DocumentState>,
    pub current_path: Option<PathBuf>,
    pub file_size_bytes: u64,
    pub cmd_mgr: CommandManager,
    pub renderer: Option<Arc<PdfRenderer>>,
    render_source: Option<(u64, Vec<u8>)>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            doc: None,
            current_path: None,
            file_size_bytes: 0,
            cmd_mgr: CommandManager::new(),
            renderer: PdfRenderer::new().ok().map(Arc::new),
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

        let annotations = pages
            .iter()
            .flat_map(|page| {
                doc.annotations
                    .get(&page.index)
                    .into_iter()
                    .flatten()
                    .map(|annotation| {
                        let mut annotation = annotation.clone();
                        annotation.rect = page.pdf_rect_to_viewport(annotation.rect);
                        if let Some(points) = &mut annotation.points {
                            for point in points.iter_mut().flatten() {
                                *point = page.pdf_point_to_viewport(point.clone());
                            }
                        }
                        annotation
                    })
            })
            .collect();

        Ok(DocumentDto {
            file_path: path_str,
            file_name,
            page_count: pages.len(),
            pages,
            annotations,
            metadata: doc.get_metadata(self.file_size_bytes),
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

        let file_size = bytes.len() as u64;
        let mut lock = state.lock();
        lock.doc = Some(doc);
        lock.current_path = Some(p);
        lock.file_size_bytes = file_size;
        lock.cmd_mgr = CommandManager::new();

        if lock.renderer.is_none() {
            lock.renderer = PdfRenderer::new().ok().map(Arc::new);
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
            annotations: Vec::new(),
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
    lock.file_size_bytes = 0;
    lock.cmd_mgr = CommandManager::new();

    if lock.renderer.is_none() {
        lock.renderer = PdfRenderer::new().ok().map(Arc::new);
    }

    lock.invalidate_render_source();

    Ok(DocumentDto {
        file_path: None,
        file_name: "Untitled.pdf".to_string(),
        page_count: 1,
        pages,
        annotations: Vec::new(),
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
            pdf_core::annotations::commit_annotations_to_pdf(&mut doc)
                .map_err(|e| e.to_string())?;
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
    keep_page_size: Option<bool>,
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
    if keep_page_size == Some(true) && crop_box.is_some() {
        let targets = pages
            .into_iter()
            .zip(new_boxes.into_iter().flatten())
            .collect();
        lock.execute_cmd(Box::new(pdf_core::resize_crop::ResizeCropPages::new(
            targets,
        )))
        .map_err(|error| error.to_string())?;
        return lock.to_dto();
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
    lock.cmd_mgr.bump_revision_dirty();
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
    mut annotation: AnnotationDto,
    state: State<'_, SharedState>,
) -> Result<DocumentDto, String> {
    let mut lock = state.lock();
    let page_index = annotation.page_index;
    let page = lock
        .doc
        .as_ref()
        .ok_or("No document open")?
        .get_page_info(page_index)
        .map_err(|error| error.to_string())?;
    annotation.rect = page
        .viewport_crop(annotation.rect)
        .ok_or("Annotation is outside the page")?;
    if let Some(points) = &mut annotation.points {
        for point in points.iter_mut().flatten() {
            *point = page.viewport_point(point.x, point.y);
        }
    }
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
    let rect = doc
        .get_page_info(page_index)
        .map_err(|e| e.to_string())?
        .viewport_crop(rect)
        .ok_or("Cover is outside the page")?;
    apply_cover_erase(doc, page_index, rect, &color).map_err(|e| e.to_string())?;
    lock.cmd_mgr.bump_revision_dirty();
    lock.invalidate_render_source();
    lock.to_dto()
}

#[tauri::command]
pub fn true_redact(
    page_index: usize,
    text: Option<String>,
    state: State<'_, SharedState>,
) -> Result<DocumentDto, String> {
    let mut lock = state.lock();
    let doc = lock.doc.as_mut().ok_or("No document open")?;
    if text
        .as_deref()
        .is_none_or(|phrase| phrase.trim().is_empty())
    {
        return Err("Enter the text to remove from this page.".into());
    }
    apply_true_redact(
        doc,
        page_index,
        PageBox::new(0.0, 0.0, 0.0, 0.0),
        text.as_deref(),
    )
    .map_err(|e| e.to_string())?;
    lock.cmd_mgr.bump_revision_dirty();
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
    let mut snapshot = doc.clone();
    pdf_core::annotations::commit_annotations_to_pdf(&mut snapshot).map_err(|e| e.to_string())?;
    safe_save(&mut snapshot, &path, make_backup).map_err(|e| e.to_string())?;
    if let Ok(meta) = std::fs::metadata(&path) {
        lock.file_size_bytes = meta.len();
    }
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
    let mut snapshot = doc.clone();
    pdf_core::annotations::commit_annotations_to_pdf(&mut snapshot).map_err(|e| e.to_string())?;
    safe_save(&mut snapshot, &p, make_backup).map_err(|e| e.to_string())?;
    if let Ok(meta) = std::fs::metadata(&p) {
        lock.file_size_bytes = meta.len();
    }
    lock.current_path = Some(p);
    lock.cmd_mgr.mark_saved();
    Ok(())
}

#[tauri::command]
pub fn evaluate_range(expression: String, total_pages: usize) -> Result<Vec<usize>, String> {
    parse_page_range(&expression, total_pages).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn search_document(
    query: String,
    case_sensitive: bool,
    state: State<'_, SharedState>,
) -> Result<Vec<SearchResult>, String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let (renderer, bytes, pages) = {
            let lock = state.lock();
            let doc = lock.doc.as_ref().ok_or("No document open")?;
            let renderer = lock.renderer.as_ref().ok_or("Renderer not ready")?.clone();
            let bytes = match &lock.render_source {
                Some((revision, bytes)) if *revision == lock.cmd_mgr.revision_id() => bytes.clone(),
                _ => doc.clone().to_bytes().map_err(|e| e.to_string())?,
            };
            let pages = (0..doc.page_count())
                .map(|index| doc.get_page_info(index))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            (renderer, bytes, pages)
        };
        let mut results = renderer
            .search_document(&bytes, &query, case_sensitive, None)
            .map_err(|e| e.to_string())?;
        for hit in &mut results {
            for rect in &mut hit.bounding_boxes {
                *rect = pages[hit.page_index].pdf_rect_to_viewport(*rect);
            }
        }
        Ok(results)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn get_document_state(state: State<'_, SharedState>) -> Result<DocumentDto, String> {
    let lock = state.lock();
    lock.to_dto()
}

#[tauri::command]
pub fn update_annotation(
    mut annotation: AnnotationDto,
    state: State<'_, SharedState>,
) -> Result<DocumentDto, String> {
    let mut lock = state.lock();
    let page_index = annotation.page_index;
    let (old_state, page) = {
        let doc = lock.doc.as_ref().ok_or("No document open")?;
        let old = doc
            .annotations
            .get(&page_index)
            .and_then(|list| list.iter().find(|a| a.id == annotation.id).cloned())
            .ok_or("Annotation not found")?;
        let page = doc
            .get_page_info(page_index)
            .map_err(|error| error.to_string())?;
        (old, page)
    };

    annotation.rect = page
        .viewport_crop(annotation.rect)
        .ok_or("Annotation is outside the page")?;
    if let Some(points) = &mut annotation.points {
        for point in points.iter_mut().flatten() {
            *point = page.viewport_point(point.x, point.y);
        }
    }
    if annotation.annot_type == AnnotationType::Image && annotation.image_base64.is_none() {
        annotation.image_base64 = old_state.image_base64.clone();
    }

    let cmd = Box::new(ModifyAnnotationCommand {
        page_index,
        old_state,
        new_state: annotation,
    });
    lock.execute_cmd(cmd).map_err(|e| e.to_string())?;
    lock.to_dto()
}

#[tauri::command]
pub fn update_metadata(
    metadata: DocumentMetadataUpdate,
    state: State<'_, SharedState>,
) -> Result<DocumentDto, String> {
    let mut lock = state.lock();
    let cmd = Box::new(UpdateMetadataCommand::new(metadata));
    lock.execute_cmd(cmd).map_err(|e| e.to_string())?;
    lock.to_dto()
}

#[tauri::command]
pub fn strip_metadata(state: State<'_, SharedState>) -> Result<DocumentDto, String> {
    let mut lock = state.lock();
    let cmd = Box::new(StripMetadataCommand::new());
    lock.execute_cmd(cmd).map_err(|e| e.to_string())?;
    lock.to_dto()
}

#[tauri::command]
pub async fn merge_pdf(
    paths: Vec<String>,
    insert_at: Option<usize>,
    state: State<'_, SharedState>,
) -> Result<DocumentDto, String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        if paths.is_empty() {
            return Err("No PDF files selected to merge".to_string());
        }
        let mut lock = state.lock();
        let cmd = Box::new(MergePdfCommand::new(paths, insert_at));
        lock.execute_cmd(cmd).map_err(|e| e.to_string())?;
        lock.to_dto()
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn extract_pages(
    pages: Vec<usize>,
    target_path: String,
    state: State<'_, SharedState>,
) -> Result<(), String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let doc = {
            let lock = state.lock();
            lock.doc.as_ref().ok_or("No document open")?.clone()
        };
        doc.extract_pages(&pages, &target_path)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn export_pages_as_images(
    pages: Vec<usize>,
    output_dir: String,
    format: String,
    dpi: u32,
    state: State<'_, SharedState>,
) -> Result<Vec<String>, String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let (renderer, bytes, stem) = {
            let mut lock = state.lock();
            let revision = lock.cmd_mgr.revision_id();
            if lock.render_source.as_ref().map(|(id, _)| *id) != Some(revision) {
                let mut doc = lock.doc.as_ref().ok_or("No document open")?.clone();
                pdf_core::annotations::commit_annotations_to_pdf(&mut doc)
                    .map_err(|e| e.to_string())?;
                let encoded = doc.to_bytes().map_err(|e| e.to_string())?;
                lock.render_source = Some((revision, encoded));
            }
            let (_, bytes) = lock.render_source.as_ref().ok_or("No document open")?;
            let renderer = lock
                .renderer
                .as_ref()
                .ok_or("Renderer not initialized")?
                .clone();
            let stem = lock
                .current_path
                .as_ref()
                .and_then(|p| p.file_stem())
                .and_then(|s| s.to_str())
                .unwrap_or("document")
                .to_string();
            (renderer, bytes.clone(), stem)
        };
        renderer
            .export_pages_as_images(
                &bytes,
                &pages,
                std::path::Path::new(&output_dir),
                &stem,
                &format,
                dpi,
                None,
            )
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn apply_area_redactions(
    items: Vec<AreaRedactItem>,
    state: State<'_, SharedState>,
) -> Result<DocumentDto, String> {
    let mut lock = state.lock();
    let doc = lock.doc.as_mut().ok_or("No document open")?;
    let mut pdf_items = Vec::with_capacity(items.len());
    for item in items {
        let page = doc
            .get_page_info(item.page_index)
            .map_err(|e| e.to_string())?;
        let pdf_rect = page
            .viewport_crop(item.rect)
            .ok_or_else(|| format!("Redaction area is outside page {}", item.page_index + 1))?;
        pdf_items.push(AreaRedactItem {
            page_index: item.page_index,
            rect: pdf_rect,
        });
    }
    core_apply_area_redactions(doc, &pdf_items).map_err(|e| e.to_string())?;
    lock.cmd_mgr.bump_revision_dirty();
    lock.invalidate_render_source();
    lock.to_dto()
}

#[tauri::command]
pub fn add_image_annotation(
    page_index: usize,
    rect: PageBox,
    image_base64: String,
    opacity: f32,
    state: State<'_, SharedState>,
) -> Result<DocumentDto, String> {
    pdf_core::annotations::decode_image_base64(&image_base64).map_err(|e| e.to_string())?;

    let mut lock = state.lock();
    let page = lock
        .doc
        .as_ref()
        .ok_or("No document open")?
        .get_page_info(page_index)
        .map_err(|e| e.to_string())?;
    let pdf_rect = page
        .viewport_crop(rect)
        .ok_or("Image annotation is outside the page")?;

    let seq = IMAGE_ANNOT_COUNTER.fetch_add(1, Ordering::Relaxed);
    let annotation = AnnotationDto {
        id: format!("img-{}-{}", lock.cmd_mgr.revision_id(), seq),
        page_index,
        annot_type: AnnotationType::Image,
        rect: pdf_rect,
        color: "#000000".to_string(),
        fill_color: None,
        stroke_width: 0.0,
        opacity: f64::from(opacity).clamp(0.0, 1.0),
        text: None,
        font_size: None,
        font_family: None,
        points: None,
        author: None,
        modified_date: None,
        locked: false,
        image_base64: Some(image_base64),
    };

    let cmd = Box::new(AddAnnotationCommand {
        page_index,
        annotation,
    });
    lock.execute_cmd(cmd).map_err(|e| e.to_string())?;
    lock.to_dto()
}

#[tauri::command]
pub fn apply_watermark_or_page_numbers(
    options: BatchOverlayOptions,
    state: State<'_, SharedState>,
) -> Result<DocumentDto, String> {
    let mut lock = state.lock();
    let cmd = Box::new(BatchOverlayCommand::new(options));
    lock.execute_cmd(cmd).map_err(|e| e.to_string())?;
    lock.to_dto()
}

#[tauri::command]
pub fn get_document_outline(state: State<'_, SharedState>) -> Result<Vec<OutlineItem>, String> {
    let lock = state.lock();
    let doc = lock.doc.as_ref().ok_or("No document open")?;
    doc.get_outline().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn detect_crop_margins(
    page_index: usize,
    state: State<'_, SharedState>,
) -> Result<PageBox, String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let (renderer, bytes, page_info) = {
            let mut lock = state.lock();
            let revision = lock.cmd_mgr.revision_id();
            let page_info = lock
                .doc
                .as_ref()
                .ok_or("No document open")?
                .get_page_info(page_index)
                .map_err(|e| e.to_string())?;
            if lock.render_source.as_ref().map(|(id, _)| *id) != Some(revision) {
                let mut doc = lock.doc.as_ref().ok_or("No document open")?.clone();
                pdf_core::annotations::commit_annotations_to_pdf(&mut doc)
                    .map_err(|e| e.to_string())?;
                let encoded = doc.to_bytes().map_err(|e| e.to_string())?;
                lock.render_source = Some((revision, encoded));
            }
            let (_, bytes) = lock.render_source.as_ref().ok_or("No document open")?;
            let renderer = lock
                .renderer
                .as_ref()
                .ok_or("Renderer not initialized")?
                .clone();
            (renderer, bytes.clone(), page_info)
        };
        renderer
            .detect_crop_margins(&bytes, page_index, page_info.width, page_info.height, None)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
