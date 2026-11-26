use crate::worker_pool::RenderWorkerPool;
use parking_lot::Mutex;
use pdf_core::batch_overlay::BatchOverlayCommand;
use pdf_core::commands::*;
use pdf_core::document::{CoreError, DocumentState};
use pdf_core::forms::{extract_form_fields, flatten_form_fields as core_flatten_form_fields};
use pdf_core::persistence::safe_save;
use pdf_core::range_parser::parse_page_range;
use pdf_core::redaction::{apply_area_redactions as core_apply_area_redactions, apply_cover_erase, apply_true_redact};
use pdf_core::renderer::{encode_png_fast, encode_rgba_frame, PdfRenderer};
use pdf_core::types::*;
use pdf_core::ObjectId;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use tauri::{Manager, State};

static IMAGE_ANNOT_COUNTER: AtomicU64 = AtomicU64::new(1);
static RENDER_GENERATIONS: OnceLock<Mutex<HashMap<u64, Arc<AtomicU64>>>> = OnceLock::new();

fn generation_slot(queue_id: u64) -> Arc<AtomicU64> {
    let map = RENDER_GENERATIONS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut lock = map.lock();
    lock.entry(queue_id)
        .or_insert_with(|| Arc::new(AtomicU64::new(0)))
        .clone()
}

#[inline]
fn is_stale_generation(generation: Option<u64>, slot: Option<&Arc<AtomicU64>>) -> bool {
    match (generation, slot) {
        (Some(gen_id), Some(s)) => gen_id < s.load(Ordering::Acquire),
        _ => false,
    }
}

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
    #[serde(default)]
    pub page_revisions: Vec<u64>,
    pub annotations: Vec<AnnotationDto>,
}

pub struct AppState {
    pub doc: Option<DocumentState>,
    pub current_path: Option<PathBuf>,
    pub custom_name: Option<String>,
    pub file_size_bytes: u64,
    pub cmd_mgr: CommandManager,
    pub renderer: Option<Arc<PdfRenderer>>,
    pub worker_pool: Option<Arc<RenderWorkerPool>>,
    worker_pool_attempted: bool,
    render_source: Option<(u64, u64, Arc<Vec<u8>>)>,
    doc_uid: u64,
    next_page_uid: u64,
    next_source_id: u64,
    page_uids: Vec<u64>,
    page_revisions: Vec<u64>,
    page_object_ids: Vec<ObjectId>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            doc: None,
            current_path: None,
            custom_name: None,
            file_size_bytes: 0,
            cmd_mgr: CommandManager::new(),
            renderer: PdfRenderer::new().ok().map(Arc::new),
            worker_pool: None,
            worker_pool_attempted: false,
            render_source: None,
            doc_uid: 0,
            next_page_uid: 1,
            next_source_id: 1,
            page_uids: Vec::new(),
            page_revisions: Vec::new(),
            page_object_ids: Vec::new(),
        }
    }

    fn next_source_id(&mut self) -> u64 {
        let id = self.next_source_id;
        self.next_source_id += 1;
        id
    }

    fn ensure_worker_pool(&mut self) -> Option<Arc<RenderWorkerPool>> {
        if self.worker_pool.is_none() && !self.worker_pool_attempted {
            self.worker_pool_attempted = true;
            let in_cargo_test = std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|d| d.file_name() == Some(std::ffi::OsStr::new("deps"))))
                == Some(true);
            if !in_cargo_test {
                self.worker_pool = RenderWorkerPool::spawn_default().map(Arc::new);
            }
        }
        self.worker_pool.clone()
    }

    fn reset_page_tracking(&mut self, initial_bytes: Option<Vec<u8>>) {
        self.doc_uid += 1;
        self.page_uids.clear();
        self.page_revisions.clear();
        self.page_object_ids.clear();
        if let Some(doc) = &self.doc {
            let count = doc.page_count();
            self.page_uids.reserve(count);
            self.page_revisions.resize(count, 1);
            self.page_object_ids.reserve(count);
            for i in 0..count {
                let uid = self.next_page_uid;
                self.next_page_uid += 1;
                self.page_uids.push(uid);
                if let Ok(oid) = doc.get_page_id(i) {
                    self.page_object_ids.push(oid);
                }
            }
        }
        if let Some(bytes) = initial_bytes {
            let revision = self.cmd_mgr.revision_id();
            let source_id = self.next_source_id();
            self.render_source = Some((revision, source_id, Arc::new(bytes)));
        } else {
            self.render_source = None;
        }
    }

    fn sync_structural_page_tracking(&mut self) {
        let Some(doc) = &self.doc else {
            self.page_uids.clear();
            self.page_revisions.clear();
            self.page_object_ids.clear();
            return;
        };
        let count = doc.page_count();
        let mut by_oid: HashMap<ObjectId, VecDeque<(u64, u64)>> = HashMap::new();
        for ((&oid, &uid), &rev) in self
            .page_object_ids
            .iter()
            .zip(&self.page_uids)
            .zip(&self.page_revisions)
        {
            by_oid.entry(oid).or_default().push_back((uid, rev));
        }

        let mut next_uids = Vec::with_capacity(count);
        let mut next_revs = Vec::with_capacity(count);
        let mut next_oids = Vec::with_capacity(count);
        for i in 0..count {
            if let Ok(oid) = doc.get_page_id(i) {
                next_oids.push(oid);
                if let Some((uid, rev)) = by_oid.get_mut(&oid).and_then(|q| q.pop_front()) {
                    next_uids.push(uid);
                    next_revs.push(rev);
                    continue;
                }
            }
            let uid = self.next_page_uid;
            self.next_page_uid += 1;
            next_uids.push(uid);
            next_revs.push(1);
        }
        self.page_uids = next_uids;
        self.page_revisions = next_revs;
        self.page_object_ids = next_oids;
    }

    fn bump_page_revisions(&mut self, pages: &[usize]) {
        for &p in pages {
            if let Some(rev) = self.page_revisions.get_mut(p) {
                *rev += 1;
            }
        }
    }

    fn page_render_tokens(&self) -> Vec<u64> {
        self.page_uids
            .iter()
            .zip(&self.page_revisions)
            .map(|(&uid, &rev)| ((uid & 0xFFFF_FFFF) << 20) | (rev & 0xF_FFFF))
            .collect()
    }

    fn apply_render_effect(&mut self, effect: CommandRenderEffect) {
        match effect {
            CommandRenderEffect::None => {}
            CommandRenderEffect::Pages(pages) => {
                self.bump_page_revisions(&pages);
                self.render_source = None;
            }
            CommandRenderEffect::Structural => {
                self.sync_structural_page_tracking();
                self.render_source = None;
            }
        }
    }

    fn ensure_render_source(&mut self) -> Result<(u64, Arc<Vec<u8>>, Arc<PdfRenderer>), String> {
        let revision = self.cmd_mgr.revision_id();
        let needs_rebuild = self
            .render_source
            .as_ref()
            .is_none_or(|(rev, _, _)| *rev != revision);
        if needs_rebuild {
            let mut doc = self.doc.as_ref().ok_or("No document open")?.clone();
            pdf_core::annotations::commit_annotations_to_pdf(&mut doc)
                .map_err(|e| e.to_string())?;
            let bytes = doc.to_bytes().map_err(|e| e.to_string())?;
            let source_id = self.next_source_id();
            self.render_source = Some((revision, source_id, Arc::new(bytes)));
        }
        let (_, source_id, bytes) = self.render_source.as_ref().ok_or("No document open")?;
        let renderer = self
            .renderer
            .as_ref()
            .ok_or("Renderer not initialized")?
            .clone();
        Ok((*source_id, Arc::clone(bytes), renderer))
    }

    fn invalidate_render_source(&mut self) {
        self.render_source = None;
    }

    pub fn clear_for_exit(&mut self) {
        self.doc = None;
        self.current_path = None;
        self.custom_name = None;
        self.file_size_bytes = 0;
        self.cmd_mgr = CommandManager::new();
        self.render_source = None;
        self.page_uids.clear();
        self.page_revisions.clear();
        self.page_object_ids.clear();
        if let Some(pool) = self.worker_pool.take() {
            pool.shutdown();
        }
        if let Some(renderer) = self.renderer.take() {
            renderer.clear_cache();
        }
    }

    pub fn execute_cmd(&mut self, cmd: Box<dyn DocumentCommand>) -> Result<(), CoreError> {
        let effect = {
            let doc = self
                .doc
                .as_mut()
                .ok_or_else(|| CoreError::InvalidOperation("No document open".into()))?;
            self.cmd_mgr.execute_tracked(doc, cmd)?
        };
        self.apply_render_effect(effect);
        Ok(())
    }

    pub fn undo_cmd(&mut self) -> Result<Option<String>, CoreError> {
        let res = {
            let doc = self
                .doc
                .as_mut()
                .ok_or_else(|| CoreError::InvalidOperation("No document open".into()))?;
            self.cmd_mgr.undo_tracked(doc)?
        };
        if let Some((desc, effect)) = res {
            self.apply_render_effect(effect);
            Ok(Some(desc))
        } else {
            Ok(None)
        }
    }

    pub fn redo_cmd(&mut self) -> Result<Option<String>, CoreError> {
        let res = {
            let doc = self
                .doc
                .as_mut()
                .ok_or_else(|| CoreError::InvalidOperation("No document open".into()))?;
            self.cmd_mgr.redo_tracked(doc)?
        };
        if let Some((desc, effect)) = res {
            self.apply_render_effect(effect);
            Ok(Some(desc))
        } else {
            Ok(None)
        }
    }

    pub fn to_dto(&self) -> Result<DocumentDto, String> {
        let doc = self.doc.as_ref().ok_or("No document open")?;
        let labels = doc.get_page_labels();
        let mut pages = Vec::new();
        for i in 0..doc.page_count() {
            let mut info = doc.get_page_info(i).map_err(|e| e.to_string())?;
            info.label = labels.get(i).cloned().flatten();
            pages.push(info);
        }

        let file_name = self
            .current_path
            .as_ref()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .map(ToString::to_string)
            .or_else(|| self.custom_name.clone())
            .unwrap_or_else(|| "Untitled.pdf".to_string());

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
            page_revisions: self.page_render_tokens(),
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

        let labels = doc.get_page_labels();
        let mut pages = Vec::new();
        for i in 0..doc.page_count() {
            let mut info = doc.get_page_info(i).map_err(|e| e.to_string())?;
            info.label = labels.get(i).cloned().flatten();
            pages.push(info);
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
        lock.custom_name = None;
        lock.file_size_bytes = file_size;
        lock.cmd_mgr = CommandManager::new();

        if lock.renderer.is_none() {
            lock.renderer = PdfRenderer::new().ok().map(Arc::new);
        }
        lock.ensure_worker_pool();
        lock.reset_page_tracking(Some(bytes));

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
            page_revisions: lock.page_render_tokens(),
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
    lock.custom_name = None;
    lock.file_size_bytes = 0;
    lock.cmd_mgr = CommandManager::new();

    if lock.renderer.is_none() {
        lock.renderer = PdfRenderer::new().ok().map(Arc::new);
    }
    lock.ensure_worker_pool();
    lock.reset_page_tracking(None);

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
        page_revisions: lock.page_revisions.clone(),
    })
}

#[tauri::command]
pub async fn render_page(
    page_index: usize,
    target_width: u32,
    format: Option<String>,
    generation: Option<u64>,
    queue_id: Option<u64>,
    state: State<'_, SharedState>,
) -> Result<tauri::ipc::Response, String> {
    let gen_slot = generation.map(|_| generation_slot(queue_id.unwrap_or(0)));
    if let (Some(gen_id), Some(slot)) = (generation, gen_slot.as_ref()) {
        let prev = slot.fetch_max(gen_id, Ordering::AcqRel);
        if gen_id < prev {
            return Err("cancelled".to_string());
        }
    }

    let state = Arc::clone(state.inner());
    let want_png = matches!(format.as_deref(), Some("png"));
    tauri::async_runtime::spawn_blocking(move || {
        if is_stale_generation(generation, gen_slot.as_ref()) {
            return Err("cancelled".to_string());
        }

        enum RenderPlan {
            Hit(Arc<pdf_core::renderer::RawBitmap>),
            Miss {
                doc_uid: u64,
                page_uid: u64,
                page_rev: u64,
                source_id: u64,
                bytes: Arc<Vec<u8>>,
                renderer: Arc<PdfRenderer>,
                worker_pool: Option<Arc<RenderWorkerPool>>,
            },
        }

        let plan = {
            let mut lock = state.lock();
            if is_stale_generation(generation, gen_slot.as_ref()) {
                return Err("cancelled".to_string());
            }
            if generation.is_some() {
                if let Some(pool) = lock.worker_pool.as_ref() {
                    pool.wake_waiters();
                }
            }
            let page_uid = *lock
                .page_uids
                .get(page_index)
                .ok_or_else(|| format!("Page index {} out of range", page_index))?;
            let page_rev = *lock
                .page_revisions
                .get(page_index)
                .ok_or_else(|| format!("Page index {} out of range", page_index))?;
            let doc_uid = lock.doc_uid;
            let renderer = lock
                .renderer
                .as_ref()
                .ok_or("Renderer not initialized")?
                .clone();

            if let Some(cached) = renderer.get_cached_rgba(doc_uid, page_uid, page_rev, target_width) {
                RenderPlan::Hit(cached)
            } else {
                if is_stale_generation(generation, gen_slot.as_ref()) {
                    return Err("cancelled".to_string());
                }
                let (source_id, bytes, _) = lock.ensure_render_source()?;
                let worker_pool = lock.ensure_worker_pool();
                RenderPlan::Miss {
                    doc_uid,
                    page_uid,
                    page_rev,
                    source_id,
                    bytes,
                    renderer,
                    worker_pool,
                }
            }
        };

        let bitmap = match plan {
            RenderPlan::Hit(cached) => cached,
            RenderPlan::Miss {
                doc_uid,
                page_uid,
                page_rev,
                source_id,
                bytes,
                renderer,
                worker_pool,
            } => {
                if is_stale_generation(generation, gen_slot.as_ref()) {
                    return Err("cancelled".to_string());
                }
                let raw = if let Some(pool) = worker_pool {
                    match pool.render_page_rgba_cancellable(
                        source_id,
                        &bytes,
                        page_index,
                        target_width,
                        || is_stale_generation(generation, gen_slot.as_ref()),
                    ) {
                        Ok(bmp) => bmp,
                        Err(err) if err == "cancelled" => return Err(err),
                        Err(_) => {
                            if is_stale_generation(generation, gen_slot.as_ref()) {
                                return Err("cancelled".to_string());
                            }
                            renderer
                                .render_page_rgba_for_source(
                                    source_id,
                                    bytes,
                                    page_index,
                                    target_width,
                                    None,
                                )
                                .map_err(|e| e.to_string())?
                        }
                    }
                } else {
                    renderer
                        .render_page_rgba_for_source(
                            source_id,
                            bytes,
                            page_index,
                            target_width,
                            None,
                        )
                        .map_err(|e| e.to_string())?
                };
                if is_stale_generation(generation, gen_slot.as_ref()) {
                    return Err("cancelled".to_string());
                }
                let arc = Arc::new(raw);
                renderer.put_cached_rgba(
                    doc_uid,
                    page_uid,
                    page_rev,
                    target_width,
                    Arc::clone(&arc),
                );
                arc
            }
        };

        if is_stale_generation(generation, gen_slot.as_ref()) {
            return Err("cancelled".to_string());
        }

        if want_png {
            let png = encode_png_fast(&bitmap).map_err(|e| e.to_string())?;
            Ok(tauri::ipc::Response::new(png))
        } else {
            let frame = match Arc::try_unwrap(bitmap) {
                Ok(owned) => owned.frame,
                Err(shared) => encode_rgba_frame(&shared),
            };
            Ok(tauri::ipc::Response::new(frame))
        }
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
    rotation_deg: Option<f64>,
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
    let rot = rotation_deg.unwrap_or(0.0);
    if (keep_page_size == Some(true) || rot.abs() >= 1e-4) && crop_box.is_some() {
        let targets = pages
            .into_iter()
            .zip(new_boxes.into_iter().flatten())
            .map(|(page, rect)| (page, rect, rot))
            .collect();
        lock.execute_cmd(Box::new(pdf_core::resize_crop::ResizeCropPages::with_rotation(
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
    lock.sync_structural_page_tracking();
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
    lock.bump_page_revisions(&[page_index]);
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
    lock.bump_page_revisions(&[page_index]);
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
pub fn save_document(
    make_backup: bool,
    app: tauri::AppHandle,
    state: State<'_, SharedState>,
) -> Result<(), String> {
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
    clear_recovery_files(&app);
    Ok(())
}

#[tauri::command]
pub fn save_document_as(
    target_path: String,
    make_backup: bool,
    app: tauri::AppHandle,
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
    lock.custom_name = None;
    lock.cmd_mgr.mark_saved();
    clear_recovery_files(&app);
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
    is_regex: Option<bool>,
    state: State<'_, SharedState>,
) -> Result<Vec<SearchResult>, String> {
    let state = Arc::clone(state.inner());
    let use_regex = is_regex.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        let (source_id, renderer, bytes, pages) = {
            let mut lock = state.lock();
            let pages = {
                let doc = lock.doc.as_ref().ok_or("No document open")?;
                (0..doc.page_count())
                    .map(|index| doc.get_page_info(index))
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?
            };
            let (source_id, bytes, renderer) = lock.ensure_render_source()?;
            (source_id, renderer, bytes, pages)
        };
        let mut results = if use_regex {
            renderer
                .search_document_regex_arc(source_id, bytes, &query, case_sensitive, None)
                .map_err(|e| e.to_string())?
        } else {
            renderer
                .search_document_arc(source_id, bytes, &query, case_sensitive, None)
                .map_err(|e| e.to_string())?
        };
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
        let (source_id, renderer, bytes, stem) = {
            let mut lock = state.lock();
            let (source_id, bytes, renderer) = lock.ensure_render_source()?;
            let stem = lock
                .current_path
                .as_ref()
                .and_then(|p| p.file_stem())
                .and_then(|s| s.to_str())
                .unwrap_or("document")
                .to_string();
            (source_id, renderer, bytes, stem)
        };
        renderer
            .export_pages_as_images_arc(
                source_id,
                bytes,
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
    let affected: Vec<usize> = pdf_items.iter().map(|item| item.page_index).collect();
    core_apply_area_redactions(doc, &pdf_items).map_err(|e| e.to_string())?;
    lock.cmd_mgr.bump_revision_dirty();
    lock.bump_page_revisions(&affected);
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
pub fn update_document_outline(
    items: Vec<OutlineItem>,
    state: State<'_, SharedState>,
) -> Result<DocumentDto, String> {
    let mut lock = state.lock();
    let previous_outline = lock
        .doc
        .as_ref()
        .ok_or("No document open")?
        .get_outline()
        .map_err(|e| e.to_string())?;
    let cmd = Box::new(UpdateOutlineCommand {
        previous_outline,
        new_outline: items,
    });
    lock.execute_cmd(cmd).map_err(|e| e.to_string())?;
    lock.to_dto()
}

#[tauri::command]
pub async fn get_page_text_spans(
    page_index: usize,
    state: State<'_, SharedState>,
) -> Result<Vec<TextSpanDto>, String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let (source_id, renderer, bytes, page_info) = {
            let mut lock = state.lock();
            let page_info = lock
                .doc
                .as_ref()
                .ok_or("No document open")?
                .get_page_info(page_index)
                .map_err(|e| e.to_string())?;
            let (source_id, bytes, renderer) = lock.ensure_render_source()?;
            (source_id, renderer, bytes, page_info)
        };
        let mut spans = renderer
            .extract_page_text_spans_arc(source_id, bytes, page_index, None)
            .map_err(|e| e.to_string())?;
        for span in &mut spans {
            span.rect = page_info.pdf_rect_to_viewport(span.rect);
        }
        Ok(spans)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_page_links(
    page_index: usize,
    state: State<'_, SharedState>,
) -> Result<Vec<LinkDto>, String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let (source_id, renderer, bytes, page_info) = {
            let mut lock = state.lock();
            let page_info = lock
                .doc
                .as_ref()
                .ok_or("No document open")?
                .get_page_info(page_index)
                .map_err(|e| e.to_string())?;
            let (source_id, bytes, renderer) = lock.ensure_render_source()?;
            (source_id, renderer, bytes, page_info)
        };
        let mut links = renderer
            .extract_page_links_arc(source_id, bytes, page_index, None)
            .map_err(|e| e.to_string())?;
        for link in &mut links {
            link.rect = page_info.pdf_rect_to_viewport(link.rect);
        }
        Ok(links)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn get_form_fields(state: State<'_, SharedState>) -> Result<Vec<FormFieldDto>, String> {
    let lock = state.lock();
    let doc = lock.doc.as_ref().ok_or("No document open")?;
    let mut fields = extract_form_fields(doc).map_err(|e| e.to_string())?;
    for field in &mut fields {
        if let Ok(page_info) = doc.get_page_info(field.page_index) {
            field.rect = page_info.pdf_rect_to_viewport(field.rect);
        }
    }
    Ok(fields)
}

#[tauri::command]
pub fn set_form_field_value(
    field_id: String,
    value: String,
    state: State<'_, SharedState>,
) -> Result<DocumentDto, String> {
    let mut lock = state.lock();
    let old_value = {
        let doc = lock.doc.as_ref().ok_or("No document open")?;
        extract_form_fields(doc)
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|f| f.id == field_id)
            .map(|f| f.value)
            .unwrap_or_default()
    };
    let cmd = Box::new(SetFormFieldCommand {
        field_id,
        old_value,
        new_value: value,
        page_index: 0,
    });
    lock.execute_cmd(cmd).map_err(|e| e.to_string())?;
    lock.to_dto()
}

#[tauri::command]
pub fn flatten_form_fields(state: State<'_, SharedState>) -> Result<DocumentDto, String> {
    let mut lock = state.lock();
    let doc = lock.doc.as_mut().ok_or("No document open")?;
    let affected = core_flatten_form_fields(doc).map_err(|e| e.to_string())?;
    if !affected.is_empty() {
        lock.cmd_mgr.bump_revision_dirty();
        lock.bump_page_revisions(&affected);
        lock.invalidate_render_source();
    }
    lock.to_dto()
}

#[tauri::command]
pub async fn detect_crop_margins(
    page_index: usize,
    state: State<'_, SharedState>,
) -> Result<PageBox, String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let (source_id, renderer, bytes, page_info) = {
            let mut lock = state.lock();
            let page_info = lock
                .doc
                .as_ref()
                .ok_or("No document open")?
                .get_page_info(page_index)
                .map_err(|e| e.to_string())?;
            let (source_id, bytes, renderer) = lock.ensure_render_source()?;
            (source_id, renderer, bytes, page_info)
        };
        renderer
            .detect_crop_margins_arc(source_id, bytes, page_index, page_info.width, page_info.height, None)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn reveal_in_folder(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.exists() {
        return Err("File does not exist on disk".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer.exe")
            .arg("/select,")
            .arg(&target)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&target)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let dir = target.parent().unwrap_or(&target);
        std::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
pub fn rename_document(new_name: String, state: State<'_, SharedState>) -> Result<DocumentDto, String> {
    let trimmed = new_name.trim();
    if trimmed.is_empty() {
        return Err("Document name cannot be empty".to_string());
    }
    if trimmed == "."
        || trimmed == ".."
        || trimmed.chars().any(|c| matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || c.is_control())
    {
        return Err("Document name contains invalid filename characters".to_string());
    }

    let final_name = if trimmed.to_ascii_lowercase().ends_with(".pdf") {
        trimmed.to_string()
    } else {
        format!("{trimmed}.pdf")
    };

    let mut lock = state.lock();
    if lock.doc.is_none() {
        return Err("No document open".to_string());
    }

    if let Some(old_path) = lock.current_path.clone() {
        let target = match old_path.parent() {
            Some(parent) => parent.join(&final_name),
            None => PathBuf::from(&final_name),
        };
        if target == old_path {
            return lock.to_dto();
        }
        let case_only = old_path
            .to_string_lossy()
            .eq_ignore_ascii_case(&target.to_string_lossy());
        if target.exists() && !case_only {
            return Err(format!("A file named \"{}\" already exists", final_name));
        }
        std::fs::rename(&old_path, &target).map_err(|e| format!("Could not rename file: {e}"))?;
        lock.current_path = Some(target);
        lock.custom_name = None;
    } else {
        lock.custom_name = Some(final_name);
    }

    lock.to_dto()
}

pub struct LaunchFileState(pub Mutex<Option<String>>);

pub fn extract_launch_file_from_args<I, S>(args: I) -> Option<String>
where
    I: IntoIterator<Item = S>,
    S: Into<std::ffi::OsString>,
{
    for raw in args.into_iter().skip(1) {
        let os: std::ffi::OsString = raw.into();
        let Some(s) = os.to_str() else {
            continue;
        };
        let trimmed = s.trim();
        if trimmed.is_empty() || trimmed.starts_with('-') {
            continue;
        }
        let path = std::path::Path::new(trimmed);
        let is_pdf = path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("pdf"));
        if !is_pdf && !path.is_file() {
            continue;
        }
        if let Ok(canon) = std::fs::canonicalize(path) {
            let lossy = canon.to_string_lossy();
            let normalized = lossy.strip_prefix(r"\\?\").unwrap_or(&lossy);
            return Some(normalized.to_string());
        }
        return Some(trimmed.to_string());
    }
    None
}

#[tauri::command]
pub fn consume_launch_file(state: State<'_, LaunchFileState>) -> Option<String> {
    state.0.lock().take()
}

#[tauri::command]
pub fn read_image_data_url(path: String) -> Result<String, String> {
    use base64::Engine as _;
    let p = std::path::Path::new(&path);
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        _ => return Err("Only PNG and JPEG images are supported.".to_string()),
    };
    let meta = std::fs::metadata(p).map_err(|e| format!("Could not read image: {e}"))?;
    if meta.len() > 25 * 1024 * 1024 {
        return Err("Image file exceeds 25 MB limit.".to_string());
    }
    let bytes = std::fs::read(p).map_err(|e| format!("Could not read image: {e}"))?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:{mime};base64,{b64}"))
}

#[derive(Serialize, Deserialize, Clone)]
pub struct RecoveryInfoDto {
    pub original_path: Option<String>,
    pub file_name: String,
    pub saved_at_ms: u64,
}

fn recovery_dir(app: &tauri::AppHandle) -> PathBuf {
    let base = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("pdf-editor"));
    base.join("recovery")
}

pub fn clear_recovery_files(app: &tauri::AppHandle) {
    let dir = recovery_dir(app);
    let _ = std::fs::remove_file(dir.join("recovery.pdf"));
    let _ = std::fs::remove_file(dir.join("recovery.pdf.tmp"));
    let _ = std::fs::remove_file(dir.join("recovery.json"));
    let _ = std::fs::remove_file(dir.join("recovery.json.tmp"));
}

#[tauri::command]
pub fn snapshot_recovery_state(
    app: tauri::AppHandle,
    state: State<'_, SharedState>,
) -> Result<bool, String> {
    let lock = state.lock();
    if !lock.cmd_mgr.is_dirty() {
        return Ok(false);
    }
    let Some(doc) = lock.doc.as_ref() else {
        return Ok(false);
    };
    let mut snapshot = doc.clone();
    pdf_core::annotations::commit_annotations_to_pdf(&mut snapshot).map_err(|e| e.to_string())?;
    let bytes = snapshot.to_bytes().map_err(|e| e.to_string())?;

    let original_path = lock
        .current_path
        .as_ref()
        .map(|p| p.to_string_lossy().to_string());
    let file_name = lock
        .current_path
        .as_ref()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .map(ToString::to_string)
        .or_else(|| lock.custom_name.clone())
        .unwrap_or_else(|| "Untitled.pdf".to_string());
    drop(lock);

    let dir = recovery_dir(&app);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let pdf_tmp = dir.join("recovery.pdf.tmp");
    let pdf_path = dir.join("recovery.pdf");
    std::fs::write(&pdf_tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&pdf_tmp, &pdf_path).map_err(|e| e.to_string())?;

    let saved_at_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let meta = RecoveryInfoDto {
        original_path,
        file_name,
        saved_at_ms,
    };
    let json_bytes = serde_json::to_vec(&meta).map_err(|e| e.to_string())?;
    let json_tmp = dir.join("recovery.json.tmp");
    let json_path = dir.join("recovery.json");
    std::fs::write(&json_tmp, json_bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&json_tmp, &json_path).map_err(|e| e.to_string())?;

    Ok(true)
}

#[tauri::command]
pub fn check_recovery_state(app: tauri::AppHandle) -> Result<Option<RecoveryInfoDto>, String> {
    let dir = recovery_dir(&app);
    let pdf_path = dir.join("recovery.pdf");
    let json_path = dir.join("recovery.json");
    if !pdf_path.is_file() || !json_path.is_file() {
        return Ok(None);
    }
    let data = std::fs::read(&json_path).map_err(|e| e.to_string())?;
    let info: RecoveryInfoDto = serde_json::from_slice(&data).map_err(|e| e.to_string())?;
    Ok(Some(info))
}

#[tauri::command]
pub fn restore_recovery_state(
    app: tauri::AppHandle,
    state: State<'_, SharedState>,
) -> Result<DocumentDto, String> {
    let dir = recovery_dir(&app);
    let pdf_path = dir.join("recovery.pdf");
    let json_path = dir.join("recovery.json");
    let info: RecoveryInfoDto = std::fs::read(&json_path)
        .ok()
        .and_then(|d| serde_json::from_slice(&d).ok())
        .unwrap_or(RecoveryInfoDto {
            original_path: None,
            file_name: "Recovered.pdf".to_string(),
            saved_at_ms: 0,
        });

    let loaded = DocumentState::from_file(&pdf_path).map_err(|e| e.to_string())?;
    let bytes = std::fs::read(&pdf_path).ok();
    let file_size = bytes.as_ref().map(|b| b.len() as u64).unwrap_or(0);

    let mut lock = state.lock();
    lock.doc = Some(loaded);
    lock.current_path = info.original_path.map(PathBuf::from);
    lock.custom_name = Some(info.file_name);
    lock.file_size_bytes = file_size;
    lock.cmd_mgr = CommandManager::new();
    lock.cmd_mgr.bump_revision_dirty();
    lock.reset_page_tracking(bytes);
    clear_recovery_files(&app);
    lock.to_dto()
}

#[tauri::command]
pub fn discard_recovery_state(app: tauri::AppHandle) -> Result<(), String> {
    clear_recovery_files(&app);
    Ok(())
}

#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") && !url.starts_with("http://") && !url.starts_with("mailto:") {
        return Err("Only http/https/mailto URLs are supported".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_render_tokens_invalidate_only_affected_pages_and_preserve_on_reorder() {
        let mut doc = DocumentState::new_blank(612.0, 792.0).unwrap();
        doc.insert_blank_page(1, 612.0, 792.0).unwrap();
        doc.insert_blank_page(2, 612.0, 792.0).unwrap();
        let bytes = doc.to_bytes().unwrap();

        let mut state = AppState::new();
        state.doc = Some(doc);
        state.reset_page_tracking(Some(bytes));

        let initial_tokens = state.page_render_tokens();
        assert_eq!(initial_tokens.len(), 3);
        assert!(state.render_source.is_some());

        // Metadata update should not change page tokens or invalidate render_source
        state
            .execute_cmd(Box::new(UpdateMetadataCommand::new(DocumentMetadataUpdate {
                title: Some("Fast".into()),
                ..Default::default()
            })))
            .unwrap();
        assert_eq!(state.page_render_tokens(), initial_tokens);
        assert!(state.render_source.is_some());

        // Annotating page 1 only bumps page 1's token
        let annot = AnnotationDto {
            id: "a1".into(),
            page_index: 1,
            annot_type: AnnotationType::Square,
            rect: PageBox::new(10.0, 10.0, 50.0, 50.0),
            color: "#ff0000".into(),
            fill_color: None,
            stroke_width: 2.0,
            opacity: 1.0,
            text: None,
            font_size: None,
            font_family: None,
            points: None,
            author: None,
            modified_date: None,
            locked: false,
            image_base64: None,
        };
        state
            .execute_cmd(Box::new(AddAnnotationCommand {
                page_index: 1,
                annotation: annot,
            }))
            .unwrap();
        let after_annot = state.page_render_tokens();
        assert_eq!(after_annot[0], initial_tokens[0]);
        assert_ne!(after_annot[1], initial_tokens[1]);
        assert_eq!(after_annot[2], initial_tokens[2]);

        // Reordering [2, 0, 1] preserves exact page tokens in their new positions
        let doc_ref = state.doc.as_ref().unwrap();
        let prev_ids: Vec<_> = (0..3).map(|i| doc_ref.get_page_id(i).unwrap()).collect();
        let new_ids = vec![prev_ids[2], prev_ids[0], prev_ids[1]];
        state
            .execute_cmd(Box::new(ReorderPagesCommand {
                previous_ids: prev_ids,
                new_ids,
            }))
            .unwrap();
        let after_reorder = state.page_render_tokens();
        assert_eq!(after_reorder, vec![after_annot[2], after_annot[0], after_annot[1]]);

        state.clear_for_exit();
        assert!(state.doc.is_none());
        assert!(state.page_uids.is_empty());
    }

    #[test]
    fn extract_launch_file_from_args_skips_flags_and_picks_pdf() {
        assert_eq!(extract_launch_file_from_args(["pdf-editor.exe"]), None);
        assert_eq!(
            extract_launch_file_from_args(["pdf-editor.exe", "--verbose", "docs/sample.pdf"]),
            Some("docs/sample.pdf".to_string())
        );
        assert_eq!(
            extract_launch_file_from_args(["pdf-editor.exe", "--flag"]),
            None
        );
    }
}
