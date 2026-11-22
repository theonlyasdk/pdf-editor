use crate::document::CoreError;
use crate::types::{PageBox, SearchResult};
use lru::LruCache;
use parking_lot::Mutex;
use pdfium_render::prelude::*;
use std::num::NonZeroUsize;
use std::path::PathBuf;
use std::sync::Arc;

pub struct PdfRenderer {
    pdfium: Arc<Pdfium>,
    cache: Mutex<LruCache<(usize, u32, u64), Vec<u8>>>,
}

impl PdfRenderer {
    /// Initializes Pdfium by discovering pdfium.dll in various likely paths.
    pub fn new() -> Result<Self, CoreError> {
        let pdfium_bindings = Self::find_and_bind_pdfium()?;
        let pdfium = Arc::new(Pdfium::new(pdfium_bindings));
        let cache = Mutex::new(LruCache::new(NonZeroUsize::new(128).unwrap()));
        Ok(Self { pdfium, cache })
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

    /// Renders a single page with caching keyed by (page_index, scale_bucket, rev_id).
    pub fn render_page_cached(
        &self,
        pdf_bytes: &[u8],
        page_index: usize,
        target_width: u32,
        revision_id: u64,
        password: Option<&str>,
    ) -> Result<Vec<u8>, CoreError> {
        let cache_key = (page_index, target_width, revision_id);
        {
            let mut cache = self.cache.lock();
            if let Some(cached) = cache.get(&cache_key) {
                return Ok(cached.clone());
            }
        }

        let rendered = self.render_page_raw(pdf_bytes, page_index, target_width, password)?;
        {
            let mut cache = self.cache.lock();
            cache.put(cache_key, rendered.clone());
        }

        Ok(rendered)
    }

    /// Renders a page directly to PNG byte stream.
    pub fn render_page_raw(
        &self,
        pdf_bytes: &[u8],
        page_index: usize,
        target_width: u32,
        password: Option<&str>,
    ) -> Result<Vec<u8>, CoreError> {
        let doc = self
            .pdfium
            .load_pdf_from_byte_slice(pdf_bytes, password)
            .map_err(|e| CoreError::Pdfium(e.to_string()))?;

        let page = doc
            .pages()
            .get(page_index as i32)
            .map_err(|e| CoreError::Pdfium(e.to_string()))?;

        let render_config = PdfRenderConfig::new().set_target_width(target_width as i32);
        let bitmap = page
            .render_with_config(&render_config)
            .map_err(|e| CoreError::Pdfium(e.to_string()))?;

        let dyn_img = bitmap
            .as_image()
            .map_err(|e| CoreError::Pdfium(e.to_string()))?;
        let mut png_bytes = Vec::new();
        dyn_img
            .write_to(
                &mut std::io::Cursor::new(&mut png_bytes),
                image::ImageFormat::Png,
            )
            .map_err(|e| CoreError::Pdfium(e.to_string()))?;

        Ok(png_bytes)
    }

    /// Extracts all text from a page.
    pub fn extract_page_text(
        &self,
        pdf_bytes: &[u8],
        page_index: usize,
        password: Option<&str>,
    ) -> Result<String, CoreError> {
        let doc = self
            .pdfium
            .load_pdf_from_byte_slice(pdf_bytes, password)
            .map_err(|e| CoreError::Pdfium(e.to_string()))?;

        let page = doc
            .pages()
            .get(page_index as i32)
            .map_err(|e| CoreError::Pdfium(e.to_string()))?;

        let text_page = page.text().map_err(|e| CoreError::Pdfium(e.to_string()))?;
        Ok(text_page.all())
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
        let doc = self
            .pdfium
            .load_pdf_from_byte_slice(pdf_bytes, password)
            .map_err(|e| CoreError::Pdfium(e.to_string()))?;

        let mut results = Vec::new();
        let options = PdfSearchOptions::new().match_case(case_sensitive);
        for (page_index, page) in doc.pages().iter().enumerate() {
            let Ok(text) = page.text() else { continue };
            let Ok(search) = text.search(query, &options) else {
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
                    match_text: query.to_owned(),
                    bounding_boxes,
                });
            }
        }

        Ok(results)
    }

    pub fn clear_cache(&self) {
        let mut cache = self.cache.lock();
        cache.clear();
    }
}
