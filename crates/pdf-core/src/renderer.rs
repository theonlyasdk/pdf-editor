use crate::document::CoreError;
use crate::types::{LinkDto, PageBox, SearchResult, TextSpanDto};
use regex::RegexBuilder;
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::ImageEncoder;
use lru::LruCache;
use parking_lot::Mutex;
use pdfium_render::prelude::*;
use rayon::prelude::*;
use std::num::NonZeroUsize;
use std::path::PathBuf;
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, OnceLock};
use std::thread::JoinHandle;

static SHARED_PDFIUM: OnceLock<Result<Arc<Pdfium>, String>> = OnceLock::new();

const RGBA_CACHE_MAX_BYTES: usize = 128 * 1024 * 1024;
const RGBA_CACHE_MAX_ENTRY_BYTES: usize = 16 * 1024 * 1024;
const RGBA_CACHE_MAX_ENTRIES: usize = 1024;
const PNG_CACHE_MAX_BYTES: usize = 48 * 1024 * 1024;
const PNG_CACHE_MAX_ENTRIES: usize = 256;

#[derive(Clone)]
pub struct RawBitmap {
    pub width: u32,
    pub height: u32,
    /// `[width_le: 4B][height_le: 4B][rgba...]` so IPC responses need no re-framing copy.
    pub frame: Vec<u8>,
}

impl RawBitmap {
    pub fn from_rgba(width: u32, height: u32, mut rgba: Vec<u8>) -> Self {
        let len = rgba.len();
        rgba.resize(len + 8, 0);
        rgba.copy_within(0..len, 8);
        rgba[0..4].copy_from_slice(&width.to_le_bytes());
        rgba[4..8].copy_from_slice(&height.to_le_bytes());
        Self {
            width,
            height,
            frame: rgba,
        }
    }

    pub fn from_frame(width: u32, height: u32, frame: Vec<u8>) -> Self {
        Self {
            width,
            height,
            frame,
        }
    }

    #[inline]
    pub fn rgba(&self) -> &[u8] {
        &self.frame[8..]
    }
}

struct ArcBytes(Arc<Vec<u8>>);

impl AsRef<[u8]> for ArcBytes {
    fn as_ref(&self) -> &[u8] {
        &self.0
    }
}

struct ByteBoundedCache<K: std::hash::Hash + Eq, V> {
    lru: LruCache<K, (Arc<V>, usize)>,
    current_bytes: usize,
    max_bytes: usize,
}

impl<K: std::hash::Hash + Eq, V> ByteBoundedCache<K, V> {
    fn new(max_entries: usize, max_bytes: usize) -> Self {
        Self {
            lru: LruCache::new(NonZeroUsize::new(max_entries.max(1)).unwrap()),
            current_bytes: 0,
            max_bytes,
        }
    }

    fn get(&mut self, key: &K) -> Option<Arc<V>> {
        self.lru.get(key).map(|(val, _)| Arc::clone(val))
    }

    fn insert(&mut self, key: K, val: Arc<V>, byte_size: usize) {
        if byte_size > self.max_bytes / 2 {
            return;
        }
        if let Some((_, old_size)) = self.lru.pop(&key) {
            self.current_bytes = self.current_bytes.saturating_sub(old_size);
        }
        while self.current_bytes + byte_size > self.max_bytes {
            let Some((_, (_, evicted_size))) = self.lru.pop_lru() else {
                break;
            };
            self.current_bytes = self.current_bytes.saturating_sub(evicted_size);
        }
        self.current_bytes += byte_size;
        self.lru.put(key, (val, byte_size));
    }

    fn clear(&mut self) {
        self.lru.clear();
        self.current_bytes = 0;
    }
}

enum ActorRequest {
    RenderRgbaRaw {
        source_id: u64,
        bytes: Arc<Vec<u8>>,
        page_index: usize,
        target_width: u32,
        password: Option<String>,
        reply: mpsc::SyncSender<Result<(u32, u32, Vec<u8>), CoreError>>,
    },
    RenderBatchDpi {
        source_id: u64,
        bytes: Arc<Vec<u8>>,
        pages: Vec<usize>,
        dpi: u32,
        password: Option<String>,
        reply: mpsc::SyncSender<Result<Vec<(usize, RawBitmap)>, CoreError>>,
    },
    ExtractText {
        source_id: u64,
        bytes: Arc<Vec<u8>>,
        page_index: usize,
        password: Option<String>,
        reply: mpsc::SyncSender<Result<String, CoreError>>,
    },
    ExtractTextSpans {
        source_id: u64,
        bytes: Arc<Vec<u8>>,
        page_index: usize,
        password: Option<String>,
        reply: mpsc::SyncSender<Result<Vec<TextSpanDto>, CoreError>>,
    },
    ExtractLinks {
        source_id: u64,
        bytes: Arc<Vec<u8>>,
        page_index: usize,
        password: Option<String>,
        reply: mpsc::SyncSender<Result<Vec<LinkDto>, CoreError>>,
    },
    Search {
        source_id: u64,
        bytes: Arc<Vec<u8>>,
        query: String,
        case_sensitive: bool,
        password: Option<String>,
        reply: mpsc::SyncSender<Result<Vec<SearchResult>, CoreError>>,
    },
    SearchRegex {
        source_id: u64,
        bytes: Arc<Vec<u8>>,
        pattern: String,
        case_sensitive: bool,
        password: Option<String>,
        reply: mpsc::SyncSender<Result<Vec<SearchResult>, CoreError>>,
    },
    DetectCropMargins {
        source_id: u64,
        bytes: Arc<Vec<u8>>,
        page_index: usize,
        page_width: f64,
        page_height: f64,
        password: Option<String>,
        reply: mpsc::SyncSender<Result<PageBox, CoreError>>,
    },
}

struct CachedPdfDoc<'a> {
    source_id: u64,
    len: usize,
    password: Option<String>,
    doc: PdfDocument<'a>,
}

fn ensure_open_doc<'a, 'b>(
    pdfium: &'a Pdfium,
    cached: &'b mut Option<CachedPdfDoc<'a>>,
    source_id: u64,
    bytes: &Arc<Vec<u8>>,
    password: Option<&str>,
) -> Result<&'b PdfDocument<'a>, CoreError> {
    let matches = cached.as_ref().is_some_and(|c| {
        source_id != 0
            && c.source_id == source_id
            && c.len == bytes.len()
            && c.password.as_deref() == password
    });

    if !matches {
        // Drop previous document before loading the next so memory is freed immediately.
        *cached = None;
        let reader = std::io::Cursor::new(ArcBytes(Arc::clone(bytes)));
        let doc = pdfium
            .load_pdf_from_reader(reader, password)
            .map_err(|e| CoreError::Pdfium(e.to_string()))?;
        *cached = Some(CachedPdfDoc {
            source_id,
            len: bytes.len(),
            password: password.map(str::to_owned),
            doc,
        });
    }

    Ok(&cached.as_ref().unwrap().doc)
}

fn render_rgba_vec_from_page(
    page: &PdfPage<'_>,
    target_width: u32,
) -> Result<(u32, u32, Vec<u8>), CoreError> {
    let render_config = PdfRenderConfig::new()
        .set_target_width(target_width.max(1) as i32)
        .set_clear_color(PdfColor::WHITE);
    let bitmap = page
        .render_with_config(&render_config)
        .map_err(|e| CoreError::Pdfium(e.to_string()))?;

    let width = bitmap.width().max(0) as u32;
    let height = bitmap.height().max(0) as u32;
    let rgba = bitmap.as_rgba_bytes();

    Ok((width, height, rgba))
}

fn render_rgba_vec_from_doc(
    doc: &PdfDocument<'_>,
    page_index: usize,
    target_width: u32,
) -> Result<(u32, u32, Vec<u8>), CoreError> {
    let page = doc
        .pages()
        .get(page_index as i32)
        .map_err(|e| CoreError::Pdfium(e.to_string()))?;
    render_rgba_vec_from_page(&page, target_width)
}

fn render_bitmap_from_doc(
    doc: &PdfDocument<'_>,
    page_index: usize,
    target_width: u32,
) -> Result<RawBitmap, CoreError> {
    let (width, height, rgba) = render_rgba_vec_from_doc(doc, page_index, target_width)?;
    Ok(RawBitmap::from_rgba(width, height, rgba))
}

fn run_pdfium_actor(pdfium: Arc<Pdfium>, rx: mpsc::Receiver<ActorRequest>) {
    let mut cached: Option<CachedPdfDoc<'_>> = None;

    while let Ok(req) = rx.recv() {
        match req {
            ActorRequest::RenderRgbaRaw {
                source_id,
                bytes,
                page_index,
                target_width,
                password,
                reply,
            } => {
                let res = ensure_open_doc(
                    &pdfium,
                    &mut cached,
                    source_id,
                    &bytes,
                    password.as_deref(),
                )
                .and_then(|doc| render_rgba_vec_from_doc(doc, page_index, target_width));
                let _ = reply.send(res);
            }
            ActorRequest::RenderBatchDpi {
                source_id,
                bytes,
                pages,
                dpi,
                password,
                reply,
            } => {
                let res = ensure_open_doc(
                    &pdfium,
                    &mut cached,
                    source_id,
                    &bytes,
                    password.as_deref(),
                )
                .and_then(|doc| {
                    let total_pages = doc.pages().len() as usize;
                    for &idx in &pages {
                        if idx >= total_pages {
                            return Err(CoreError::PageOutOfRange(idx, total_pages));
                        }
                    }
                    let mut out = Vec::with_capacity(pages.len());
                    for &page_index in &pages {
                        let page = doc
                            .pages()
                            .get(page_index as i32)
                            .map_err(|e| CoreError::Pdfium(e.to_string()))?;
                        let width_pt = page.width().value;
                        let target_width = ((width_pt / 72.0) * dpi as f32)
                            .round()
                            .clamp(1.0, 16384.0) as u32;
                        let (w, h, rgba) = render_rgba_vec_from_page(&page, target_width)?;
                        out.push((page_index, RawBitmap::from_rgba(w, h, rgba)));
                    }
                    Ok(out)
                });
                let _ = reply.send(res);
            }
            ActorRequest::ExtractText {
                source_id,
                bytes,
                page_index,
                password,
                reply,
            } => {
                let res = ensure_open_doc(
                    &pdfium,
                    &mut cached,
                    source_id,
                    &bytes,
                    password.as_deref(),
                )
                .and_then(|doc| {
                    let page = doc
                        .pages()
                        .get(page_index as i32)
                        .map_err(|e| CoreError::Pdfium(e.to_string()))?;
                    let text_page = page.text().map_err(|e| CoreError::Pdfium(e.to_string()))?;
                    Ok(text_page.all())
                });
                let _ = reply.send(res);
            }
            ActorRequest::ExtractTextSpans {
                source_id,
                bytes,
                page_index,
                password,
                reply,
            } => {
                let res = ensure_open_doc(
                    &pdfium,
                    &mut cached,
                    source_id,
                    &bytes,
                    password.as_deref(),
                )
                .and_then(|doc| {
                    let page = doc
                        .pages()
                        .get(page_index as i32)
                        .map_err(|e| CoreError::Pdfium(e.to_string()))?;
                    let text_page = page.text().map_err(|e| CoreError::Pdfium(e.to_string()))?;
                    Ok(extract_text_spans_from_page(&text_page))
                });
                let _ = reply.send(res);
            }
            ActorRequest::ExtractLinks {
                source_id,
                bytes,
                page_index,
                password,
                reply,
            } => {
                let res = ensure_open_doc(
                    &pdfium,
                    &mut cached,
                    source_id,
                    &bytes,
                    password.as_deref(),
                )
                .and_then(|doc| {
                    let page = doc
                        .pages()
                        .get(page_index as i32)
                        .map_err(|e| CoreError::Pdfium(e.to_string()))?;
                    Ok(extract_links_from_page(&page))
                });
                let _ = reply.send(res);
            }
            ActorRequest::Search {
                source_id,
                bytes,
                query,
                case_sensitive,
                password,
                reply,
            } => {
                let res = ensure_open_doc(
                    &pdfium,
                    &mut cached,
                    source_id,
                    &bytes,
                    password.as_deref(),
                )
                .map(|doc| {
                    let mut results = Vec::new();
                    let options = PdfSearchOptions::new().match_case(case_sensitive);
                    for (page_index, page) in doc.pages().iter().enumerate() {
                        let Ok(text) = page.text() else { continue };
                        let Ok(search) = text.search(&query, &options) else {
                            continue;
                        };
                        for found in search.iter(PdfSearchDirection::SearchForward) {
                            let mut bounding_boxes = Vec::new();
                            for segment in found.iter() {
                                let rect = segment.bounds();
                                bounding_boxes.push(PageBox::new(
                                    f64::from(rect.left().value),
                                    f64::from(rect.bottom().value),
                                    f64::from(rect.width().value),
                                    f64::from(rect.height().value),
                                ));
                            }
                            results.push(SearchResult {
                                page_index,
                                match_text: query.clone(),
                                bounding_boxes,
                            });
                        }
                    }
                    results
                });
                let _ = reply.send(res);
            }
            ActorRequest::SearchRegex {
                source_id,
                bytes,
                pattern,
                case_sensitive,
                password,
                reply,
            } => {
                let res = RegexBuilder::new(&pattern)
                    .case_insensitive(!case_sensitive)
                    .build()
                    .map_err(|e| CoreError::InvalidOperation(format!("Invalid regex: {}", e)))
                    .and_then(|re| {
                        let doc = ensure_open_doc(
                            &pdfium,
                            &mut cached,
                            source_id,
                            &bytes,
                            password.as_deref(),
                        )?;
                        let mut results = Vec::new();
                        for (page_index, page) in doc.pages().iter().enumerate() {
                            let Ok(text_page) = page.text() else { continue };
                            results.extend(search_regex_on_page(&text_page, page_index, &re));
                        }
                        Ok(results)
                    });
                let _ = reply.send(res);
            }
            ActorRequest::DetectCropMargins {
                source_id,
                bytes,
                page_index,
                page_width,
                page_height,
                password,
                reply,
            } => {
                let res = ensure_open_doc(
                    &pdfium,
                    &mut cached,
                    source_id,
                    &bytes,
                    password.as_deref(),
                )
                .and_then(|doc| {
                    let total = doc.pages().len() as usize;
                    if page_index >= total {
                        return Err(CoreError::PageOutOfRange(page_index, total));
                    }
                    let bmp = render_bitmap_from_doc(doc, page_index, 1000)?;
                    Ok(scan_crop_margins(&bmp, page_width, page_height))
                });
                let _ = reply.send(res);
            }
        }
    }

    drop(cached);
}

fn scan_crop_margins(bmp: &RawBitmap, page_width: f64, page_height: f64) -> PageBox {
    let img_w = bmp.width;
    let img_h = bmp.height;
    if img_w == 0 || img_h == 0 {
        return PageBox::new(0.0, 0.0, page_width, page_height);
    }

    let mut min_x = u32::MAX;
    let mut min_y = u32::MAX;
    let mut max_x = 0u32;
    let mut max_y = 0u32;
    let mut found = false;

    for (idx, px) in bmp.rgba().chunks_exact(4).enumerate() {
        if px[0] < 248 || px[1] < 248 || px[2] < 248 {
            let x = (idx as u32) % img_w;
            let y = (idx as u32) / img_w;
            found = true;
            if x < min_x {
                min_x = x;
            }
            if y < min_y {
                min_y = y;
            }
            if x > max_x {
                max_x = x;
            }
            if y > max_y {
                max_y = y;
            }
        }
    }

    if !found {
        return PageBox::new(0.0, 0.0, page_width, page_height);
    }

    let scale_x = page_width / f64::from(img_w);
    let scale_y = page_height / f64::from(img_h);
    let pad = 4.0;

    let x1 = (f64::from(min_x) * scale_x - pad).max(0.0);
    let y1 = (f64::from(min_y) * scale_y - pad).max(0.0);
    let x2 = (f64::from(max_x + 1) * scale_x + pad).min(page_width);
    let y2 = (f64::from(max_y + 1) * scale_y + pad).min(page_height);

    PageBox::new(x1, y1, (x2 - x1).max(1.0), (y2 - y1).max(1.0))
}

pub fn encode_png_rgba(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>, CoreError> {
    let mut png_bytes = Vec::with_capacity((rgba.len() / 4).max(1024));
    let encoder =
        PngEncoder::new_with_quality(&mut png_bytes, CompressionType::Fast, FilterType::Sub);
    encoder
        .write_image(rgba, width, height, image::ExtendedColorType::Rgba8)
        .map_err(|e| CoreError::Pdfium(e.to_string()))?;
    Ok(png_bytes)
}

pub fn encode_png_fast(bitmap: &RawBitmap) -> Result<Vec<u8>, CoreError> {
    encode_png_rgba(bitmap.width, bitmap.height, bitmap.rgba())
}

pub fn encode_rgba_frame(bitmap: &RawBitmap) -> Vec<u8> {
    bitmap.frame.clone()
}

fn pdf_bytes_fingerprint(bytes: &[u8]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.len().hash(&mut hasher);
    let head = &bytes[..bytes.len().min(1024)];
    head.hash(&mut hasher);
    if bytes.len() > 1024 {
        bytes[bytes.len() - 1024..].hash(&mut hasher);
    }
    hasher.finish()
}

pub struct PdfRenderer {
    actor_tx: Mutex<Option<Sender<ActorRequest>>>,
    actor_handle: Mutex<Option<JoinHandle<()>>>,
    rgba_cache: Mutex<ByteBoundedCache<(u64, u64, u64, u32), RawBitmap>>,
    png_cache: Mutex<ByteBoundedCache<(u64, usize, u32, u64), Vec<u8>>>,
}

impl Drop for PdfRenderer {
    fn drop(&mut self) {
        self.actor_tx.lock().take();
        if let Some(handle) = self.actor_handle.lock().take() {
            let _ = handle.join();
        }
    }
}

impl PdfRenderer {
    /// Initializes Pdfium by discovering pdfium.dll in various likely paths.
    pub fn new() -> Result<Self, CoreError> {
        let res = SHARED_PDFIUM.get_or_init(|| {
            Self::find_and_bind_pdfium()
                .map(|bindings| Arc::new(Pdfium::new(bindings)))
                .map_err(|e| e.to_string())
        });
        let pdfium = match res {
            Ok(arc) => Arc::clone(arc),
            Err(msg) => return Err(CoreError::Pdfium(msg.clone())),
        };

        let (tx, rx) = mpsc::channel();
        let handle = std::thread::Builder::new()
            .name("pdfium-renderer".to_string())
            .spawn(move || run_pdfium_actor(pdfium, rx))
            .map_err(CoreError::Io)?;

        Ok(Self {
            actor_tx: Mutex::new(Some(tx)),
            actor_handle: Mutex::new(Some(handle)),
            rgba_cache: Mutex::new(ByteBoundedCache::new(
                RGBA_CACHE_MAX_ENTRIES,
                RGBA_CACHE_MAX_BYTES,
            )),
            png_cache: Mutex::new(ByteBoundedCache::new(
                PNG_CACHE_MAX_ENTRIES,
                PNG_CACHE_MAX_BYTES,
            )),
        })
    }

    fn send_request<T>(&self, build: impl FnOnce(mpsc::SyncSender<Result<T, CoreError>>) -> ActorRequest) -> Result<T, CoreError> {
        let tx = self
            .actor_tx
            .lock()
            .as_ref()
            .cloned()
            .ok_or_else(|| CoreError::Pdfium("Renderer actor is shut down".into()))?;
        let (reply_tx, reply_rx) = mpsc::sync_channel(1);
        tx.send(build(reply_tx))
            .map_err(|_| CoreError::Pdfium("Renderer actor channel closed".into()))?;
        reply_rx
            .recv()
            .map_err(|_| CoreError::Pdfium("Renderer actor dropped reply".into()))?
    }

    fn find_and_bind_pdfium() -> Result<Box<dyn PdfiumLibraryBindings>, CoreError> {
        let mut candidate_paths: Vec<PathBuf> = Vec::new();

        if let Ok(exe) = std::env::current_exe() {
            if let Some(parent) = exe.parent() {
                candidate_paths.push(parent.to_path_buf());
                candidate_paths.push(parent.join("bin"));
            }
        }
        candidate_paths.push(PathBuf::from("bin"));
        candidate_paths.push(PathBuf::from("../bin"));
        candidate_paths.push(PathBuf::from("../../bin"));

        for p in candidate_paths {
            if p.exists() {
                let lib_name = Pdfium::pdfium_platform_library_name_at_path(&p);
                if let Ok(bindings) = Pdfium::bind_to_library(&lib_name) {
                    return Ok(bindings);
                }
            }
        }

        Pdfium::bind_to_system_library().map_err(|e| {
            CoreError::Pdfium(format!("Failed to locate or bind Pdfium library: {}", e))
        })
    }

    pub fn get_cached_rgba(
        &self,
        doc_uid: u64,
        page_uid: u64,
        page_rev: u64,
        target_width: u32,
    ) -> Option<Arc<RawBitmap>> {
        self.rgba_cache
            .lock()
            .get(&(doc_uid, page_uid, page_rev, target_width))
    }

    pub fn put_cached_rgba(
        &self,
        doc_uid: u64,
        page_uid: u64,
        page_rev: u64,
        target_width: u32,
        bitmap: Arc<RawBitmap>,
    ) {
        let bytes = bitmap.frame.len();
        if bytes > RGBA_CACHE_MAX_ENTRY_BYTES {
            return;
        }
        self.rgba_cache
            .lock()
            .insert((doc_uid, page_uid, page_rev, target_width), bitmap, bytes);
    }

    pub fn render_page_rgba_vec_for_source(
        &self,
        source_id: u64,
        pdf_bytes: Arc<Vec<u8>>,
        page_index: usize,
        target_width: u32,
        password: Option<&str>,
    ) -> Result<(u32, u32, Vec<u8>), CoreError> {
        let pw = password.map(str::to_owned);
        self.send_request(|reply| ActorRequest::RenderRgbaRaw {
            source_id,
            bytes: pdf_bytes,
            page_index,
            target_width,
            password: pw,
            reply,
        })
    }

    pub fn render_page_rgba_for_source(
        &self,
        source_id: u64,
        pdf_bytes: Arc<Vec<u8>>,
        page_index: usize,
        target_width: u32,
        password: Option<&str>,
    ) -> Result<RawBitmap, CoreError> {
        let (width, height, rgba) =
            self.render_page_rgba_vec_for_source(source_id, pdf_bytes, page_index, target_width, password)?;
        Ok(RawBitmap::from_rgba(width, height, rgba))
    }

    /// Renders a single page with caching keyed by (doc_fingerprint, page_index, target_width, rev_id).
    pub fn render_page_cached(
        &self,
        pdf_bytes: &[u8],
        page_index: usize,
        target_width: u32,
        revision_id: u64,
        password: Option<&str>,
    ) -> Result<Vec<u8>, CoreError> {
        let doc_fp = pdf_bytes_fingerprint(pdf_bytes);
        let cache_key = (doc_fp, page_index, target_width, revision_id);
        if let Some(cached) = self.png_cache.lock().get(&cache_key) {
            return Ok((*cached).clone());
        }

        let rendered = self.render_page_raw(pdf_bytes, page_index, target_width, password)?;
        let len = rendered.len();
        let arc_rendered = Arc::new(rendered);
        self.png_cache
            .lock()
            .insert(cache_key, Arc::clone(&arc_rendered), len);

        Ok((*arc_rendered).clone())
    }

    /// Renders a page directly to PNG byte stream.
    pub fn render_page_raw(
        &self,
        pdf_bytes: &[u8],
        page_index: usize,
        target_width: u32,
        password: Option<&str>,
    ) -> Result<Vec<u8>, CoreError> {
        let bytes = Arc::new(pdf_bytes.to_vec());
        let (width, height, rgba) =
            self.render_page_rgba_vec_for_source(0, bytes, page_index, target_width, password)?;
        encode_png_rgba(width, height, &rgba)
    }

    /// Extracts all text from a page.
    pub fn extract_page_text(
        &self,
        pdf_bytes: &[u8],
        page_index: usize,
        password: Option<&str>,
    ) -> Result<String, CoreError> {
        let bytes = Arc::new(pdf_bytes.to_vec());
        let pw = password.map(str::to_owned);
        self.send_request(|reply| ActorRequest::ExtractText {
            source_id: 0,
            bytes,
            page_index,
            password: pw,
            reply,
        })
    }

    /// Searches text across all pages.
    pub fn search_document(
        &self,
        pdf_bytes: &[u8],
        query: &str,
        case_sensitive: bool,
        password: Option<&str>,
    ) -> Result<Vec<SearchResult>, CoreError> {
        if query.trim().is_empty() {
            return Ok(Vec::new());
        }
        let bytes = Arc::new(pdf_bytes.to_vec());
        self.search_document_arc(0, bytes, query, case_sensitive, password)
    }

    pub fn search_document_arc(
        &self,
        source_id: u64,
        pdf_bytes: Arc<Vec<u8>>,
        query: &str,
        case_sensitive: bool,
        password: Option<&str>,
    ) -> Result<Vec<SearchResult>, CoreError> {
        if query.trim().is_empty() {
            return Ok(Vec::new());
        }
        let query = query.to_owned();
        let pw = password.map(str::to_owned);
        self.send_request(|reply| ActorRequest::Search {
            source_id,
            bytes: pdf_bytes,
            query,
            case_sensitive,
            password: pw,
            reply,
        })
    }

    pub fn search_document_regex_arc(
        &self,
        source_id: u64,
        pdf_bytes: Arc<Vec<u8>>,
        pattern: &str,
        case_sensitive: bool,
        password: Option<&str>,
    ) -> Result<Vec<SearchResult>, CoreError> {
        if pattern.trim().is_empty() {
            return Ok(Vec::new());
        }
        let pattern = pattern.to_owned();
        let pw = password.map(str::to_owned);
        self.send_request(|reply| ActorRequest::SearchRegex {
            source_id,
            bytes: pdf_bytes,
            pattern,
            case_sensitive,
            password: pw,
            reply,
        })
    }

    pub fn extract_page_text_spans_arc(
        &self,
        source_id: u64,
        pdf_bytes: Arc<Vec<u8>>,
        page_index: usize,
        password: Option<&str>,
    ) -> Result<Vec<TextSpanDto>, CoreError> {
        let pw = password.map(str::to_owned);
        self.send_request(|reply| ActorRequest::ExtractTextSpans {
            source_id,
            bytes: pdf_bytes,
            page_index,
            password: pw,
            reply,
        })
    }

    pub fn extract_page_links_arc(
        &self,
        source_id: u64,
        pdf_bytes: Arc<Vec<u8>>,
        page_index: usize,
        password: Option<&str>,
    ) -> Result<Vec<LinkDto>, CoreError> {
        let pw = password.map(str::to_owned);
        self.send_request(|reply| ActorRequest::ExtractLinks {
            source_id,
            bytes: pdf_bytes,
            page_index,
            password: pw,
            reply,
        })
    }

    pub fn clear_cache(&self) {
        self.rgba_cache.lock().clear();
        self.png_cache.lock().clear();
    }

    /// Exports selected 0-based pages as PNG or JPEG files at the requested DPI.
    #[allow(clippy::too_many_arguments)]
    pub fn export_pages_as_images(
        &self,
        pdf_bytes: &[u8],
        pages: &[usize],
        output_dir: &std::path::Path,
        file_stem: &str,
        format: &str,
        dpi: u32,
        password: Option<&str>,
    ) -> Result<Vec<String>, CoreError> {
        let bytes = Arc::new(pdf_bytes.to_vec());
        self.export_pages_as_images_arc(0, bytes, pages, output_dir, file_stem, format, dpi, password)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn export_pages_as_images_arc(
        &self,
        source_id: u64,
        pdf_bytes: Arc<Vec<u8>>,
        pages: &[usize],
        output_dir: &std::path::Path,
        file_stem: &str,
        format: &str,
        dpi: u32,
        password: Option<&str>,
    ) -> Result<Vec<String>, CoreError> {
        let fmt_lower = format.trim().to_ascii_lowercase();
        let (is_jpeg, ext) = match fmt_lower.as_str() {
            "png" => (false, "png"),
            "jpg" | "jpeg" => (true, "jpg"),
            other => {
                return Err(CoreError::ValidationFailed(format!(
                    "Unsupported export image format '{}'. Use 'png' or 'jpeg'.",
                    other
                )));
            }
        };

        let clamped_dpi = dpi.clamp(36, 600);
        std::fs::create_dir_all(output_dir)?;

        let safe_stem: String = file_stem
            .chars()
            .map(|c| {
                if c.is_alphanumeric() || c == '-' || c == '_' {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        let safe_stem = if safe_stem.is_empty() {
            "document"
        } else {
            safe_stem.as_str()
        };

        // Rasterize pages in a single open-document pass, then encode & write in parallel.
        let pw = password.map(str::to_owned);
        let bitmaps = self.send_request(|reply| ActorRequest::RenderBatchDpi {
            source_id,
            bytes: pdf_bytes,
            pages: pages.to_vec(),
            dpi: clamped_dpi,
            password: pw,
            reply,
        })?;

        bitmaps
            .into_par_iter()
            .map(|(page_index, bmp)| {
                let out_path =
                    output_dir.join(format!("{}_page_{}.{}", safe_stem, page_index + 1, ext));
                let mut file = std::io::BufWriter::new(std::fs::File::create(&out_path)?);
                if is_jpeg {
                    let mut rgb = Vec::with_capacity((bmp.width * bmp.height * 3) as usize);
                    for px in bmp.rgba().chunks_exact(4) {
                        rgb.extend_from_slice(&px[..3]);
                    }
                    let img = image::RgbImage::from_raw(bmp.width, bmp.height, rgb)
                        .ok_or_else(|| CoreError::Pdfium("Invalid RGB buffer dimensions".into()))?;
                    image::DynamicImage::ImageRgb8(img)
                        .write_to(&mut file, image::ImageFormat::Jpeg)
                        .map_err(|e| CoreError::Pdfium(e.to_string()))?;
                } else {
                    let encoder = PngEncoder::new_with_quality(
                        &mut file,
                        CompressionType::Fast,
                        FilterType::Sub,
                    );
                    encoder
                        .write_image(
                            bmp.rgba(),
                            bmp.width,
                            bmp.height,
                            image::ExtendedColorType::Rgba8,
                        )
                        .map_err(|e| CoreError::Pdfium(e.to_string()))?;
                }
                Ok(out_path.to_string_lossy().into_owned())
            })
            .collect()
    }

    /// Auto-detects the non-whitespace content bounding box in viewport coordinates.
    pub fn detect_crop_margins(
        &self,
        pdf_bytes: &[u8],
        page_index: usize,
        page_width: f64,
        page_height: f64,
        password: Option<&str>,
    ) -> Result<PageBox, CoreError> {
        let bytes = Arc::new(pdf_bytes.to_vec());
        self.detect_crop_margins_arc(0, bytes, page_index, page_width, page_height, password)
    }

    pub fn detect_crop_margins_arc(
        &self,
        source_id: u64,
        pdf_bytes: Arc<Vec<u8>>,
        page_index: usize,
        page_width: f64,
        page_height: f64,
        password: Option<&str>,
    ) -> Result<PageBox, CoreError> {
        let pw = password.map(str::to_owned);
        self.send_request(|reply| ActorRequest::DetectCropMargins {
            source_id,
            bytes: pdf_bytes,
            page_index,
            page_width,
            page_height,
            password: pw,
            reply,
        })
    }
}

fn extract_text_spans_from_page(text_page: &PdfPageText<'_>) -> Vec<TextSpanDto> {
    let mut spans = Vec::new();
    let mut cur_text = String::new();
    let mut min_x = 0.0_f64;
    let mut min_y = 0.0_f64;
    let mut max_x = 0.0_f64;
    let mut max_y = 0.0_f64;

    let flush = |spans: &mut Vec<TextSpanDto>,
                 text: &mut String,
                 min_x: f64,
                 min_y: f64,
                 max_x: f64,
                 max_y: f64| {
        if !text.is_empty() {
            spans.push(TextSpanDto {
                text: std::mem::take(text),
                rect: PageBox::new(
                    min_x,
                    min_y,
                    (max_x - min_x).max(0.5),
                    (max_y - min_y).max(1.0),
                ),
            });
        }
    };

    for ch in text_page.chars().iter() {
        let Some(c) = ch.unicode_char() else {
            continue;
        };
        if c == '\r' || c == '\n' || c.is_control() || c.is_whitespace() {
            flush(&mut spans, &mut cur_text, min_x, min_y, max_x, max_y);
            continue;
        }
        let Ok(bounds) = ch.loose_bounds() else {
            continue;
        };
        let x = f64::from(bounds.left().value);
        let y = f64::from(bounds.bottom().value);
        let w = f64::from(bounds.width().value).max(0.5);
        let h = f64::from(bounds.height().value).max(1.0);
        let x2 = x + w;
        let y2 = y + h;

        if cur_text.is_empty() {
            cur_text.push(c);
            min_x = x;
            min_y = y;
            max_x = x2;
            max_y = y2;
        } else {
            let line_h = (max_y - min_y).max(h);
            let same_line = (y - min_y).abs() <= line_h * 0.6;
            let close_x = (x - max_x) <= line_h * 0.35 && x >= min_x - line_h * 0.25;
            if same_line && close_x {
                cur_text.push(c);
                min_x = min_x.min(x);
                min_y = min_y.min(y);
                max_x = max_x.max(x2);
                max_y = max_y.max(y2);
            } else {
                flush(&mut spans, &mut cur_text, min_x, min_y, max_x, max_y);
                cur_text.push(c);
                min_x = x;
                min_y = y;
                max_x = x2;
                max_y = y2;
            }
        }
    }
    flush(&mut spans, &mut cur_text, min_x, min_y, max_x, max_y);
    spans
}

fn extract_links_from_page(page: &PdfPage<'_>) -> Vec<LinkDto> {
    let mut links = Vec::new();
    for link in page.links().iter() {
        let Ok(rect) = link.rect() else {
            continue;
        };
        let bbox = PageBox::new(
            f64::from(rect.left().value),
            f64::from(rect.bottom().value),
            f64::from(rect.width().value),
            f64::from(rect.height().value),
        );
        if bbox.width <= 0.0 || bbox.height <= 0.0 {
            continue;
        }

        let mut uri: Option<String> = None;
        let mut target_page: Option<usize> = None;

        if let Some(action) = link.action() {
            match action {
                PdfAction::Uri(uri_action) => {
                    if let Ok(u) = uri_action.uri() {
                        let trimmed = u.trim().to_string();
                        if !trimmed.is_empty() {
                            uri = Some(trimmed);
                        }
                    }
                }
                PdfAction::LocalDestination(local) => {
                    if let Ok(dest) = local.destination() {
                        if let Ok(idx) = dest.page_index() {
                            target_page = Some(idx as usize);
                        }
                    }
                }
                _ => {}
            }
        }

        if uri.is_none() && target_page.is_none() {
            if let Some(dest) = link.destination() {
                if let Ok(idx) = dest.page_index() {
                    target_page = Some(idx as usize);
                }
            }
        }

        if uri.is_some() || target_page.is_some() {
            links.push(LinkDto {
                rect: bbox,
                uri,
                target_page,
            });
        }
    }
    links
}

fn merge_boxes_by_line(boxes: &[PageBox]) -> Vec<PageBox> {
    let mut merged: Vec<PageBox> = Vec::new();
    for &b in boxes {
        if let Some(last) = merged.last_mut() {
            let line_h = last.height.max(b.height);
            let same_line = (b.y - last.y).abs() <= line_h * 0.6;
            if same_line {
                let min_x = last.x.min(b.x);
                let min_y = last.y.min(b.y);
                let max_x = (last.x + last.width).max(b.x + b.width);
                let max_y = (last.y + last.height).max(b.y + b.height);
                *last = PageBox::new(min_x, min_y, max_x - min_x, max_y - min_y);
                continue;
            }
        }
        merged.push(b);
    }
    merged
}

fn search_regex_on_page(
    text_page: &PdfPageText<'_>,
    page_index: usize,
    re: &regex::Regex,
) -> Vec<SearchResult> {
    let mut full_text = String::new();
    let mut char_ranges: Vec<(usize, usize, Option<PageBox>)> = Vec::new();

    for ch in text_page.chars().iter() {
        let Some(c) = ch.unicode_char() else {
            continue;
        };
        let start = full_text.len();
        full_text.push(c);
        let end = full_text.len();
        let bbox = if c == '\r' || c == '\n' || c.is_control() {
            None
        } else {
            ch.loose_bounds().ok().map(|b| {
                PageBox::new(
                    f64::from(b.left().value),
                    f64::from(b.bottom().value),
                    f64::from(b.width().value).max(0.5),
                    f64::from(b.height().value).max(1.0),
                )
            })
        };
        char_ranges.push((start, end, bbox));
    }

    let mut results = Vec::new();
    for m in re.find_iter(&full_text) {
        if m.as_str().is_empty() {
            continue;
        }
        let start_idx = char_ranges.partition_point(|&(_, end, _)| end <= m.start());
        let mut boxes = Vec::new();
        for &(s, _, bbox) in &char_ranges[start_idx..] {
            if s >= m.end() {
                break;
            }
            if let Some(b) = bbox {
                boxes.push(b);
            }
        }
        let bounding_boxes = merge_boxes_by_line(&boxes);
        if !bounding_boxes.is_empty() {
            results.push(SearchResult {
                page_index,
                match_text: m.as_str().to_string(),
                bounding_boxes,
            });
        }
    }
    results
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::DocumentState;

    #[test]
    fn rgba_frame_and_fast_png_encode_roundtrip() {
        let bmp = RawBitmap::from_rgba(
            2,
            2,
            vec![
                255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
            ],
        );
        let frame = encode_rgba_frame(&bmp);
        assert_eq!(frame.len(), 8 + 16);
        assert_eq!(u32::from_le_bytes(frame[0..4].try_into().unwrap()), 2);
        assert_eq!(u32::from_le_bytes(frame[4..8].try_into().unwrap()), 2);

        let png = encode_png_fast(&bmp).unwrap();
        assert_eq!(&png[0..4], &[0x89, b'P', b'N', b'G']);
    }

    #[test]
    fn byte_bounded_cache_evicts_by_memory_budget() {
        let mut cache = ByteBoundedCache::new(16, 100);
        cache.insert(1u32, Arc::new(vec![0u8; 40]), 40);
        cache.insert(2u32, Arc::new(vec![0u8; 40]), 40);
        assert!(cache.get(&1).is_some());
        assert!(cache.get(&2).is_some());

        // Inserting 40 more bytes exceeds 100-byte budget and evicts LRU (1)
        cache.insert(3u32, Arc::new(vec![0u8; 40]), 40);
        assert!(cache.get(&1).is_none());
        assert!(cache.get(&2).is_some());
        assert!(cache.get(&3).is_some());
    }

    #[test]
    fn cached_source_renders_multiple_pages_without_reparsing() {
        let mut doc = DocumentState::new_blank(612.0, 792.0).unwrap();
        doc.insert_blank_page(1, 612.0, 792.0).unwrap();
        let bytes = Arc::new(doc.to_bytes().unwrap());
        let renderer = PdfRenderer::new().unwrap();

        let p0 = renderer
            .render_page_rgba_for_source(42, Arc::clone(&bytes), 0, 400, None)
            .unwrap();
        let p1 = renderer
            .render_page_rgba_for_source(42, Arc::clone(&bytes), 1, 400, None)
            .unwrap();
        assert_eq!(p0.width, 400);
        assert_eq!(p1.width, 400);
        assert_eq!(p0.rgba().len(), (p0.width * p0.height * 4) as usize);
    }

    #[test]
    fn rgba_cache_holds_500_thumbnails_without_entry_cap_eviction() {
        let renderer = PdfRenderer::new().unwrap();
        let thumb = Arc::new(RawBitmap::from_rgba(16, 16, vec![255u8; 16 * 16 * 4]));
        for page_uid in 0..500u64 {
            renderer.put_cached_rgba(1, page_uid, 1, 240, Arc::clone(&thumb));
        }
        assert!(renderer.get_cached_rgba(1, 0, 1, 240).is_some());
        assert!(renderer.get_cached_rgba(1, 499, 1, 240).is_some());
    }

    #[test]
    fn png_cache_separates_distinct_documents_with_same_revision() {
        let mut d1 = DocumentState::new_blank(612.0, 792.0).unwrap();
        let mut d2 = DocumentState::new_blank(400.0, 400.0).unwrap();
        let b1 = d1.to_bytes().unwrap();
        let b2 = d2.to_bytes().unwrap();
        let renderer = PdfRenderer::new().unwrap();

        let png1 = renderer.render_page_cached(&b1, 0, 200, 1, None).unwrap();
        let png2 = renderer.render_page_cached(&b2, 0, 200, 1, None).unwrap();
        assert_ne!(png1, png2);
    }
}
