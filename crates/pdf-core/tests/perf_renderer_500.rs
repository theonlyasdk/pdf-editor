use pdf_core::renderer::{encode_png_fast, PdfRenderer, RawBitmap};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

fn percentile_ms(sorted_ms: &[f64], p: f64) -> f64 {
    if sorted_ms.is_empty() {
        return 0.0;
    }
    let idx = ((sorted_ms.len() - 1) as f64 * p).round() as usize;
    sorted_ms[idx.min(sorted_ms.len() - 1)]
}

#[test]
#[ignore = "Manual release benchmark against large_500pages.pdf"]
fn perf_renderer_500pages() {
    let fixture =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/large_500pages.pdf");
    let bytes = Arc::new(std::fs::read(&fixture).expect("read large_500pages.pdf"));
    let renderer = PdfRenderer::new().expect("PdfRenderer::new");

    // 1. Cold vs Warm
    let mut cold_ms = Vec::with_capacity(10);
    for _ in 0..10 {
        let t0 = Instant::now();
        let _ = renderer
            .render_page_rgba_vec_for_source(0, Arc::clone(&bytes), 0, 160, None)
            .expect("cold");
        cold_ms.push(t0.elapsed().as_secs_f64() * 1000.0);
    }
    let _ = renderer
        .render_page_rgba_vec_for_source(1, Arc::clone(&bytes), 0, 160, None)
        .expect("prime");
    let mut warm_ms = Vec::with_capacity(10);
    for _ in 0..10 {
        let t0 = Instant::now();
        let _ = renderer
            .render_page_rgba_vec_for_source(1, Arc::clone(&bytes), 0, 160, None)
            .expect("warm");
        warm_ms.push(t0.elapsed().as_secs_f64() * 1000.0);
    }
    let cold_mean = cold_ms.iter().sum::<f64>() / cold_ms.len() as f64;
    let warm_mean = warm_ms.iter().sum::<f64>() / warm_ms.len() as f64;
    println!(
        "[1] Cold vs Warm (page 0 @ 160px): cold_mean={:.3}ms, warm_mean={:.3}ms",
        cold_mean, warm_mean
    );

    // 2. 500 pages @ 160, 240, 320, 480
    for &w in &[160u32, 240, 320, 480] {
        let mut times = Vec::with_capacity(500);
        let t_total = Instant::now();
        for p in 0..500 {
            let t0 = Instant::now();
            let _ = renderer
                .render_page_rgba_vec_for_source(1, Arc::clone(&bytes), p, w, None)
                .expect("render");
            times.push(t0.elapsed().as_secs_f64() * 1000.0);
        }
        let total_ms = t_total.elapsed().as_secs_f64() * 1000.0;
        let mean = times.iter().sum::<f64>() / times.len() as f64;
        times.sort_by(|a, b| a.total_cmp(b));
        println!(
            "[2] 500 pages @ {}px: total={:.1}ms, mean={:.3}ms, p50={:.3}ms, p95={:.3}ms",
            w,
            total_ms,
            mean,
            percentile_ms(&times, 0.50),
            percentile_ms(&times, 0.95)
        );
    }

    // 3. RawBitmap::from_rgba + encode_png_fast (20 pages @ 240px and 480px)
    for &w in &[240u32, 480] {
        let mut raw_pages = Vec::with_capacity(20);
        for p in 0..20 {
            raw_pages.push(
                renderer
                    .render_page_rgba_vec_for_source(1, Arc::clone(&bytes), p, w, None)
                    .expect("render"),
            );
        }
        let t_copy = Instant::now();
        let mut bitmaps = Vec::with_capacity(20);
        for (bw, bh, rgba) in raw_pages {
            bitmaps.push(RawBitmap::from_rgba(bw, bh, rgba));
        }
        let copy_ms = t_copy.elapsed().as_secs_f64() * 1000.0;

        let t_png = Instant::now();
        for bmp in &bitmaps {
            let _ = encode_png_fast(bmp).expect("png");
        }
        let png_ms = t_png.elapsed().as_secs_f64() * 1000.0;
        println!(
            "[3] Copy + PNG (20 pages @ {}px): from_rgba_total={:.3}ms ({:.3}ms/page) | encode_png_fast_total={:.1}ms ({:.3}ms/page)",
            w,
            copy_ms,
            copy_ms / 20.0,
            png_ms,
            png_ms / 20.0
        );
    }
}
