use lopdf::content::{Content, Operation};
use lopdf::{dictionary, Document, Object, Stream};
use pdf_core::document::DocumentState;
use pdf_core::range_parser::parse_page_range;
use pdf_core::renderer::PdfRenderer;
use pdf_core::types::*;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

fn ensure_fixtures_dir() -> PathBuf {
    let dir = PathBuf::from("tests/fixtures");
    fs::create_dir_all(&dir).unwrap();
    dir
}

type PageSpec = (f64, f64, i32, Option<PageBox>);

/// Generates a test PDF with text.
fn create_test_pdf(path: &Path, page_count: usize, page_specs: Option<Vec<PageSpec>>) {
    let mut doc = Document::with_version("1.5");
    let pages_id = doc.new_object_id();

    let font_id = doc.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type1",
        "BaseFont" => "Helvetica",
    });

    let resources_id = doc.add_object(dictionary! {
        "Font" => dictionary! {
            "F1" => font_id,
        },
    });

    let mut page_ids = Vec::new();

    for i in 0..page_count {
        let (w, h, rot, crop) = if let Some(ref specs) = page_specs {
            specs[i % specs.len()]
        } else {
            (612.0, 792.0, 0, None)
        };

        let content = Content {
            operations: vec![
                Operation::new("BT", vec![]),
                Operation::new("Tf", vec!["F1".into(), 18.into()]),
                Operation::new("Td", vec![72.into(), (h - 72.0).into()]),
                Operation::new(
                    "Tj",
                    vec![Object::string_literal(format!(
                        "Page {} of {} - Generated Fixture",
                        i + 1,
                        page_count
                    ))],
                ),
                Operation::new("ET", vec![]),
            ],
        };

        let stream_id = doc.add_object(Stream::new(dictionary! {}, content.encode().unwrap()));

        let mut page_dict = dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "Contents" => stream_id,
            "MediaBox" => vec![0.into(), 0.into(), w.into(), h.into()],
        };

        if rot != 0 {
            page_dict.set("Rotate", rot);
        }

        if let Some(cb) = crop {
            page_dict.set(
                "CropBox",
                vec![
                    cb.x.into(),
                    cb.y.into(),
                    (cb.x + cb.width).into(),
                    (cb.y + cb.height).into(),
                ],
            );
        }

        let page_id = doc.add_object(page_dict);
        page_ids.push(page_id);
    }

    let pages_dict = dictionary! {
        "Type" => "Pages",
        "Kids" => page_ids.iter().map(|&id| Object::Reference(id)).collect::<Vec<_>>(),
        "Count" => page_count as i64,
        "Resources" => resources_id,
        "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
    };
    doc.objects.insert(pages_id, Object::Dictionary(pages_dict));

    let catalog_id = doc.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
    });
    doc.trailer.set("Root", catalog_id);

    doc.save(path).unwrap();
}

#[test]
fn test_generate_and_verify_all_fixtures() {
    let dir = ensure_fixtures_dir();

    // 1. Single page text PDF
    let p_single = dir.join("1page_text.pdf");
    create_test_pdf(&p_single, 1, None);
    let doc_single = DocumentState::from_file(&p_single).unwrap();
    assert_eq!(doc_single.page_count(), 1);

    // 2. Rotated pages (0, 90, 180, 270)
    let p_rot = dir.join("rotated_pages.pdf");
    create_test_pdf(
        &p_rot,
        4,
        Some(vec![
            (612.0, 792.0, 0, None),
            (612.0, 792.0, 90, None),
            (612.0, 792.0, 180, None),
            (612.0, 792.0, 270, None),
        ]),
    );
    let doc_rot = DocumentState::from_file(&p_rot).unwrap();
    assert_eq!(doc_rot.get_page_info(0).unwrap().rotation, 0);
    assert_eq!(doc_rot.get_page_info(1).unwrap().rotation, 90);
    assert_eq!(doc_rot.get_page_info(2).unwrap().rotation, 180);
    assert_eq!(doc_rot.get_page_info(3).unwrap().rotation, 270);

    // 3. Mixed sizes (Letter, A4, Landscape)
    let p_mixed = dir.join("mixed_sizes.pdf");
    create_test_pdf(
        &p_mixed,
        3,
        Some(vec![
            (612.0, 792.0, 0, None), // US Letter
            (595.0, 842.0, 0, None), // A4
            (792.0, 612.0, 0, None), // US Letter Landscape
        ]),
    );
    let doc_mixed = DocumentState::from_file(&p_mixed).unwrap();
    assert_eq!(doc_mixed.get_page_info(0).unwrap().width, 612.0);
    assert_eq!(doc_mixed.get_page_info(1).unwrap().width, 595.0);
    assert_eq!(doc_mixed.get_page_info(2).unwrap().width, 792.0);

    // 4. CropBox != MediaBox
    let p_crop = dir.join("crop_box_distinct.pdf");
    create_test_pdf(
        &p_crop,
        1,
        Some(vec![(
            612.0,
            792.0,
            0,
            Some(PageBox::new(36.0, 36.0, 540.0, 720.0)),
        )]),
    );
    let doc_crop = DocumentState::from_file(&p_crop).unwrap();
    let p0 = doc_crop.get_page_info(0).unwrap();
    assert_eq!(p0.media_box.width, 612.0);
    assert_eq!(p0.crop_box.unwrap().width, 540.0);

    // 5. Redaction Target fixture
    let p_redact = dir.join("redaction_target.pdf");
    {
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let font_id = doc.add_object(dictionary! {
            "Type" => "Font",
            "Subtype" => "Type1",
            "BaseFont" => "Helvetica",
        });
        let resources_id = doc.add_object(dictionary! {
            "Font" => dictionary! { "F1" => font_id },
        });

        let content = Content {
            operations: vec![
                Operation::new("BT", vec![]),
                Operation::new("Tf", vec!["F1".into(), 16.into()]),
                Operation::new("Td", vec![100.into(), 600.into()]),
                Operation::new("Tj", vec![Object::string_literal("Public Title Statement")]),
                Operation::new("Td", vec![0.into(), (-40).into()]),
                Operation::new(
                    "Tj",
                    vec![Object::string_literal("CONFIDENTIAL_PASSWORD_XYZ_98765")],
                ),
                Operation::new("ET", vec![]),
            ],
        };
        let stream_id = doc.add_object(Stream::new(dictionary! {}, content.encode().unwrap()));
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "Contents" => stream_id,
            "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
        });

        let pages_dict = dictionary! {
            "Type" => "Pages",
            "Kids" => vec![page_id.into()],
            "Count" => 1,
            "Resources" => resources_id,
            "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
        };
        doc.objects.insert(pages_id, Object::Dictionary(pages_dict));
        let catalog_id = doc.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        doc.trailer.set("Root", catalog_id);
        doc.save(&p_redact).unwrap();
    }

    // 6. Malformed/Truncated file handling test
    let p_malformed = dir.join("malformed_truncated.pdf");
    fs::write(&p_malformed, b"%PDF-1.5\n%%EOF_CORRUPT_BYTE_STREAM").unwrap();
    let malformed_res = DocumentState::from_file(&p_malformed);
    assert!(
        malformed_res.is_err(),
        "Corrupted PDF must return error cleanly, never panic"
    );
}

#[test]
fn test_500_page_performance_budget() {
    let dir = ensure_fixtures_dir();
    let p_500 = dir.join("large_500pages.pdf");

    // Generate 500-page document
    let gen_start = Instant::now();
    create_test_pdf(&p_500, 500, None);
    let gen_dur = gen_start.elapsed();
    println!("Generated 500-page PDF in {:?}", gen_dur);

    // Performance Benchmark: Document Load Time
    let load_start = Instant::now();
    let doc = DocumentState::from_file(&p_500).unwrap();
    let load_dur = load_start.elapsed();
    println!("Loaded 500-page PDF in {:?}", load_dur);
    assert_eq!(doc.page_count(), 500);
    // Performance budget: load under 500ms
    assert!(
        load_dur.as_millis() < 500,
        "500-page load took {}ms, budget is 500ms",
        load_dur.as_millis()
    );

    // Performance Benchmark: Render First Page
    let renderer = PdfRenderer::new().unwrap();
    let doc_bytes = fs::read(&p_500).unwrap();
    let render_start = Instant::now();
    let png = renderer.render_page_raw(&doc_bytes, 0, 800, None).unwrap();
    let render_dur = render_start.elapsed();
    println!("Rendered first page of 500-page PDF in {:?}", render_dur);
    assert!(!png.is_empty());
    // Performance budget: first page render under 1000ms
    assert!(
        render_dur.as_millis() < 1000,
        "First page render took {}ms, budget is 1000ms",
        render_dur.as_millis()
    );
}

#[test]
fn test_fuzz_range_parser_safety() {
    let inputs = vec![
        "",
        "   ",
        ",,,,",
        "!",
        "!all",
        "1-99999999999999999999999999999999",
        "-5",
        "0",
        "1/0",
        "///",
        "odd/even",
        "last-9999999",
        "!1-5/2",
        "1-2-3-4",
        "NaN",
        "null",
        "undefined",
        "\0\r\n\t",
        "1-5, 8, 11-end, odd, even, last, last-2, !3, 1-20/3",
    ];

    for expr in inputs {
        // Must never panic! Returns either Ok or Err
        let _ = parse_page_range(expr, 50);
    }
}
