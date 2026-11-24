use crate::document::CoreError;
use crate::types::{PageBox, SearchResult};
use lru::LruCache;
use parking_lot::Mutex;
use pdfium_render::prelude::*;
use std::num::NonZeroUsize;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

static SHARED_PDFIUM: OnceLock<Result<Arc<Pdfium>, String>> = OnceLock::new();

pub struct PdfRenderer {
    pdfium: Arc<Pdfium>,
    cache: Mutex<LruCache<(usize, u32, u64), Vec<u8>>>,
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
        let fmt_lower = format.trim().to_ascii_lowercase();
        let (img_format, ext) = match fmt_lower.as_str() {
            "png" => (image::ImageFormat::Png, "png"),
            "jpg" | "jpeg" => (image::ImageFormat::Jpeg, "jpg"),
            other => {
                return Err(CoreError::ValidationFailed(format!(
                    "Unsupported export image format '{}'. Use 'png' or 'jpeg'.",
                    other
                )));
            }
        };

        let clamped_dpi = dpi.clamp(36, 600);
        std::fs::create_dir_all(output_dir)?;

        let doc = self
            .pdfium
            .load_pdf_from_byte_slice(pdf_bytes, password)
            .map_err(|e| CoreError::Pdfium(e.to_string()))?;

        let total_pages = doc.pages().len() as usize;
        for &idx in pages {
            if idx >= total_pages {
                return Err(CoreError::PageOutOfRange(idx, total_pages));
            }
        }

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

        let mut output_paths = Vec::with_capacity(pages.len());
        for &page_index in pages {
            let page = doc
                .pages()
                .get(page_index as i32)
                .map_err(|e| CoreError::Pdfium(e.to_string()))?;

            let width_pt = page.width().value;
            let target_width = ((width_pt / 72.0) * clamped_dpi as f32)
                .round()
                .clamp(1.0, 16384.0) as i32;
            let render_config = PdfRenderConfig::new().set_target_width(target_width);
            let bitmap = page
                .render_with_config(&render_config)
                .map_err(|e| CoreError::Pdfium(e.to_string()))?;

            let dyn_img = bitmap
                .as_image()
                .map_err(|e| CoreError::Pdfium(e.to_string()))?;

            let out_path = output_dir.join(format!("{}_page_{}.{}", safe_stem, page_index + 1, ext));
            let mut file = std::fs::File::create(&out_path)?;

            if img_format == image::ImageFormat::Jpeg {
                let rgb = composite_over_white(&dyn_img.to_rgba8());
                image::DynamicImage::ImageRgb8(rgb)
                    .write_to(&mut file, image::ImageFormat::Jpeg)
                    .map_err(|e| CoreError::Pdfium(e.to_string()))?;
            } else {
                dyn_img
                    .write_to(&mut file, image::ImageFormat::Png)
                    .map_err(|e| CoreError::Pdfium(e.to_string()))?;
            }

            output_paths.push(out_path.to_string_lossy().into_owned());
        }

        Ok(output_paths)
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
        let doc = self
            .pdfium
            .load_pdf_from_byte_slice(pdf_bytes, password)
            .map_err(|e| CoreError::Pdfium(e.to_string()))?;

        let total = doc.pages().len() as usize;
        if page_index >= total {
            return Err(CoreError::PageOutOfRange(page_index, total));
        }

        let page = doc
            .pages()
            .get(page_index as i32)
            .map_err(|e| CoreError::Pdfium(e.to_string()))?;

        let render_config = PdfRenderConfig::new().set_target_width(1000);
        let bitmap = page
            .render_with_config(&render_config)
            .map_err(|e| CoreError::Pdfium(e.to_string()))?;
        let dyn_img = bitmap
            .as_image()
            .map_err(|e| CoreError::Pdfium(e.to_string()))?;
        let rgb = composite_over_white(&dyn_img.to_rgba8());
        let (img_w, img_h) = rgb.dimensions();

        if img_w == 0 || img_h == 0 {
            return Ok(PageBox::new(0.0, 0.0, page_width, page_height));
        }

        let mut min_x = u32::MAX;
        let mut min_y = u32::MAX;
        let mut max_x = 0u32;
        let mut max_y = 0u32;
        let mut found = false;

        for (x, y, px) in rgb.enumerate_pixels() {
            if px[0] < 248 || px[1] < 248 || px[2] < 248 {
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
            return Ok(PageBox::new(0.0, 0.0, page_width, page_height));
        }

        let scale_x = page_width / f64::from(img_w);
        let scale_y = page_height / f64::from(img_h);
        let pad = 4.0;

        let x1 = (f64::from(min_x) * scale_x - pad).max(0.0);
        let y1 = (f64::from(min_y) * scale_y - pad).max(0.0);
        let x2 = (f64::from(max_x + 1) * scale_x + pad).min(page_width);
        let y2 = (f64::from(max_y + 1) * scale_y + pad).min(page_height);

        Ok(PageBox::new(
            x1,
            y1,
            (x2 - x1).max(1.0),
            (y2 - y1).max(1.0),
        ))
    }
}

fn composite_over_white(rgba: &image::RgbaImage) -> image::RgbImage {
    let (w, h) = rgba.dimensions();
    let mut rgb = image::RgbImage::new(w, h);
    for (x, y, px) in rgba.enumerate_pixels() {
        let a = f32::from(px[3]) / 255.0;
        let inv = 1.0 - a;
        let r = (f32::from(px[0]) * a + 255.0 * inv).round() as u8;
        let g = (f32::from(px[1]) * a + 255.0 * inv).round() as u8;
        let b = (f32::from(px[2]) * a + 255.0 * inv).round() as u8;
        rgb.put_pixel(x, y, image::Rgb([r, g, b]));
    }
    rgb
}
