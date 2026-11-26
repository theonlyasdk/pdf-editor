use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use lopdf::content::{Content, Operation};
use lopdf::{dictionary, Document, Object, Stream};
use pdf_core::annotations::{commit_annotations_to_pdf, decode_image_base64};
use pdf_core::batch_overlay::BatchOverlayCommand;
use pdf_core::commands::*;
use pdf_core::document::DocumentState;
use pdf_core::redaction::apply_area_redactions;
use pdf_core::renderer::PdfRenderer;
use pdf_core::types::*;
use tempfile::tempdir;

fn make_text_pdf_doc(pages_text: &[Vec<(f64, f64, &str)>]) -> DocumentState {
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

    let mut page_ids = Vec::new();
    for lines in pages_text {
        let mut ops = Vec::new();
        for &(x, y, txt) in lines {
            ops.push(Operation::new("BT", vec![]));
            ops.push(Operation::new("Tf", vec!["F1".into(), 14.into()]));
            ops.push(Operation::new("Td", vec![x.into(), y.into()]));
            ops.push(Operation::new("Tj", vec![Object::string_literal(txt)]));
            ops.push(Operation::new("ET", vec![]));
        }
        let stream_id = doc.add_object(Stream::new(
            dictionary! {},
            Content { operations: ops }.encode().unwrap(),
        ));
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "Contents" => stream_id,
            "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
        });
        page_ids.push(page_id);
    }

    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => page_ids.iter().map(|&id| Object::Reference(id)).collect::<Vec<_>>(),
            "Count" => page_ids.len() as i64,
            "Resources" => resources_id,
            "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
        }),
    );
    let catalog_id = doc.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
    });
    doc.trailer.set("Root", catalog_id);

    let bytes = {
        let mut b = Vec::new();
        doc.save_to(&mut b).unwrap();
        b
    };
    DocumentState::from_bytes(&bytes).unwrap()
}

#[test]
fn test_update_annotation_command_invertibility() {
    let mut doc = DocumentState::new_blank(612.0, 792.0).unwrap();
    let mut cmd_mgr = CommandManager::new();

    let original = AnnotationDto {
        id: "ann-1".into(),
        page_index: 0,
        annot_type: AnnotationType::FreeText,
        rect: PageBox::new(50.0, 500.0, 150.0, 40.0),
        color: "#111111".into(),
        fill_color: None,
        stroke_width: 1.0,
        opacity: 1.0,
        text: Some("Original".into()),
        font_size: Some(12.0),
        font_family: Some("Helvetica".into()),
        points: None,
        author: Some("Alice".into()),
        modified_date: Some("2026-01-01".into()),
        locked: false,
        image_base64: None,
    };

    cmd_mgr
        .execute(
            &mut doc,
            Box::new(AddAnnotationCommand {
                page_index: 0,
                annotation: original.clone(),
            }),
        )
        .unwrap();

    let mut updated = original.clone();
    updated.rect = PageBox::new(80.0, 520.0, 200.0, 60.0);
    updated.color = "#ef4444".into();
    updated.fill_color = Some("#fef08a".into());
    updated.stroke_width = 2.5;
    updated.opacity = 0.75;
    updated.text = Some("Updated Note".into());
    updated.font_size = Some(16.0);
    updated.font_family = Some("Times-Roman".into());
    updated.locked = true;
    updated.modified_date = Some("2026-11-24".into());

    cmd_mgr
        .execute(
            &mut doc,
            Box::new(ModifyAnnotationCommand {
                page_index: 0,
                old_state: original.clone(),
                new_state: updated.clone(),
            }),
        )
        .unwrap();

    let current = &doc.annotations[&0][0];
    assert_eq!(current.text.as_deref(), Some("Updated Note"));
    assert_eq!(current.color, "#ef4444");
    assert_eq!(current.fill_color.as_deref(), Some("#fef08a"));
    assert_eq!(current.stroke_width, 2.5);
    assert_eq!(current.opacity, 0.75);
    assert_eq!(current.font_size, Some(16.0));
    assert_eq!(current.font_family.as_deref(), Some("Times-Roman"));
    assert!(current.locked);
    assert_eq!(current.modified_date.as_deref(), Some("2026-11-24"));

    cmd_mgr.undo(&mut doc).unwrap();
    assert_eq!(doc.annotations[&0][0].text.as_deref(), Some("Original"));
    assert!(!doc.annotations[&0][0].locked);

    cmd_mgr.redo(&mut doc).unwrap();
    assert_eq!(doc.annotations[&0][0].text.as_deref(), Some("Updated Note"));
    assert!(doc.annotations[&0][0].locked);

    commit_annotations_to_pdf(&mut doc).unwrap();
    let page_id = doc.get_page_id(0).unwrap();
    let annots = doc
        .doc
        .get_dictionary(page_id)
        .unwrap()
        .get(b"Annots")
        .unwrap()
        .as_array()
        .unwrap();
    let annot_dict = doc
        .doc
        .get_dictionary(annots[0].as_reference().unwrap())
        .unwrap();
    assert_eq!(annot_dict.get(b"F").unwrap().as_i64().unwrap(), 4 | 128);
    assert_eq!(
        annot_dict.get(b"M").unwrap().as_str().unwrap(),
        b"2026-11-24"
    );
}

#[test]
fn test_update_and_strip_metadata_invertibility() {
    let mut doc = DocumentState::new_blank(612.0, 792.0).unwrap();
    let mut cmd_mgr = CommandManager::new();

    // Attach XMP metadata & PieceInfo to test stripping hidden info
    let xmp_id = doc.doc.add_object(Stream::new(
        dictionary! { "Type" => "Metadata", "Subtype" => "XML" },
        b"<xmp>SECRET_METADATA_TAG</xmp>".to_vec(),
    ));
    let root_id = doc.doc.trailer.get(b"Root").unwrap().as_reference().unwrap();
    doc.doc
        .get_dictionary_mut(root_id)
        .unwrap()
        .set("Metadata", xmp_id);
    let page_id = doc.get_page_id(0).unwrap();
    doc.doc
        .get_dictionary_mut(page_id)
        .unwrap()
        .set("PieceInfo", dictionary! { "Private" => Object::string_literal("HIDDEN_TOOL_DATA") });

    let update = DocumentMetadataUpdate {
        title: Some("Quarterly Report".into()),
        author: Some("Jane Doe".into()),
        subject: Some("Finance".into()),
        keywords: Some("q4, report".into()),
        creator: Some("PDF Studio".into()),
        producer: Some("pdf-core".into()),
    };

    cmd_mgr
        .execute(&mut doc, Box::new(UpdateMetadataCommand::new(update)))
        .unwrap();
    let meta = doc.get_metadata(0);
    assert_eq!(meta.title.as_deref(), Some("Quarterly Report"));
    assert_eq!(meta.author.as_deref(), Some("Jane Doe"));
    assert_eq!(meta.subject.as_deref(), Some("Finance"));
    assert_eq!(meta.keywords.as_deref(), Some("q4, report"));
    assert_eq!(meta.creator.as_deref(), Some("PDF Studio"));
    assert_eq!(meta.producer.as_deref(), Some("pdf-core"));

    cmd_mgr
        .execute(&mut doc, Box::new(StripMetadataCommand::new()))
        .unwrap();
    let stripped_meta = doc.get_metadata(0);
    assert!(stripped_meta.title.is_none());
    assert!(stripped_meta.author.is_none());
    assert!(doc.doc.trailer.get(b"Info").is_err());
    assert!(doc
        .doc
        .get_dictionary(root_id)
        .unwrap()
        .get(b"Metadata")
        .is_err());
    assert!(doc
        .doc
        .get_dictionary(page_id)
        .unwrap()
        .get(b"PieceInfo")
        .is_err());

    let bytes = doc.to_bytes().unwrap();
    let raw = String::from_utf8_lossy(&bytes);
    assert!(!raw.contains("SECRET_METADATA_TAG"));
    assert!(!raw.contains("HIDDEN_TOOL_DATA"));
    assert!(!raw.contains("Quarterly Report"));

    // Undo strip -> metadata and XMP restored
    cmd_mgr.undo(&mut doc).unwrap();
    assert_eq!(
        doc.get_metadata(0).title.as_deref(),
        Some("Quarterly Report")
    );
    assert!(doc
        .doc
        .get_dictionary(root_id)
        .unwrap()
        .get(b"Metadata")
        .is_ok());

    // Undo update -> empty metadata
    cmd_mgr.undo(&mut doc).unwrap();
    assert!(doc.get_metadata(0).title.is_none());
}

#[test]
fn test_merge_pdf_and_extract_pages() {
    let dir = tempdir().unwrap();
    let path_a = dir.path().join("a.pdf");
    let path_b = dir.path().join("b.pdf");
    let extracted_path = dir.path().join("extracted.pdf");

    let mut doc_a = make_text_pdf_doc(&[
        vec![(72.0, 700.0, "ALPHA_ONE")],
        vec![(72.0, 700.0, "ALPHA_TWO")],
    ]);
    doc_a.save_to_file(&path_a).unwrap();

    let mut doc_b = make_text_pdf_doc(&[
        vec![(72.0, 700.0, "BETA_ONE")],
        vec![(72.0, 700.0, "BETA_TWO")],
    ]);
    doc_b.save_to_file(&path_b).unwrap();

    let mut main_doc = DocumentState::from_file(&path_a).unwrap();
    let mut cmd_mgr = CommandManager::new();

    // Add an annotation on page 1 (ALPHA_TWO) before merging at index 1
    cmd_mgr
        .execute(
            &mut main_doc,
            Box::new(AddAnnotationCommand {
                page_index: 1,
                annotation: AnnotationDto {
                    id: "note-a2".into(),
                    page_index: 1,
                    annot_type: AnnotationType::StickyNote,
                    rect: PageBox::new(100.0, 600.0, 24.0, 24.0),
                    color: "#facc15".into(),
                    fill_color: None,
                    stroke_width: 1.0,
                    opacity: 1.0,
                    text: Some("Check ALPHA_TWO".into()),
                    font_size: None,
                    font_family: None,
                    points: None,
                    author: None,
                    modified_date: None,
                    locked: false,
                    image_base64: None,
                },
            }),
        )
        .unwrap();

    // Merge B at index 1 -> order: ALPHA_ONE, BETA_ONE, BETA_TWO, ALPHA_TWO
    cmd_mgr
        .execute(
            &mut main_doc,
            Box::new(MergePdfCommand::new(
                vec![path_b.to_string_lossy().into_owned()],
                Some(1),
            )),
        )
        .unwrap();

    assert_eq!(main_doc.page_count(), 4);
    assert!(main_doc.annotations.get(&1).is_none());
    assert_eq!(main_doc.annotations[&3][0].id, "note-a2");
    assert_eq!(main_doc.annotations[&3][0].page_index, 3);

    let renderer = PdfRenderer::new().unwrap();
    let merged_bytes = main_doc.to_bytes().unwrap();
    assert!(renderer
        .extract_page_text(&merged_bytes, 0, None)
        .unwrap()
        .contains("ALPHA_ONE"));
    assert!(renderer
        .extract_page_text(&merged_bytes, 1, None)
        .unwrap()
        .contains("BETA_ONE"));
    assert!(renderer
        .extract_page_text(&merged_bytes, 2, None)
        .unwrap()
        .contains("BETA_TWO"));
    assert!(renderer
        .extract_page_text(&merged_bytes, 3, None)
        .unwrap()
        .contains("ALPHA_TWO"));

    // Extract pages [0, 2] -> ALPHA_ONE, BETA_TWO
    main_doc.extract_pages(&[0, 2], &extracted_path).unwrap();
    let extracted_bytes = std::fs::read(&extracted_path).unwrap();
    let extracted_doc = DocumentState::from_bytes(&extracted_bytes).unwrap();
    assert_eq!(extracted_doc.page_count(), 2);
    assert!(renderer
        .extract_page_text(&extracted_bytes, 0, None)
        .unwrap()
        .contains("ALPHA_ONE"));
    assert!(renderer
        .extract_page_text(&extracted_bytes, 1, None)
        .unwrap()
        .contains("BETA_TWO"));

    // Undo merge -> back to 2 pages and annotation at index 1
    cmd_mgr.undo(&mut main_doc).unwrap();
    assert_eq!(main_doc.page_count(), 2);
    assert_eq!(main_doc.annotations[&1][0].id, "note-a2");

    // Redo merge -> 4 pages again
    cmd_mgr.redo(&mut main_doc).unwrap();
    assert_eq!(main_doc.page_count(), 4);
}

#[test]
fn test_export_pages_as_images_png_and_jpeg() {
    let dir = tempdir().unwrap();
    let mut doc = make_text_pdf_doc(&[
        vec![(72.0, 700.0, "EXPORT PAGE 1")],
        vec![(72.0, 700.0, "EXPORT PAGE 2")],
    ]);
    let bytes = doc.to_bytes().unwrap();
    let renderer = PdfRenderer::new().unwrap();

    let png_dir = dir.path().join("png");
    let png_paths = renderer
        .export_pages_as_images(&bytes, &[0, 1], &png_dir, "sample", "png", 144, None)
        .unwrap();
    assert_eq!(png_paths.len(), 2);
    let png0 = std::fs::read(&png_paths[0]).unwrap();
    assert_eq!(&png0[0..4], &[0x89, b'P', b'N', b'G']);
    let decoded_png = image::load_from_memory(&png0).unwrap();
    assert_eq!(decoded_png.width(), 1224); // 612pt / 72 * 144 = 1224px

    let jpg_dir = dir.path().join("jpg");
    let jpg_paths = renderer
        .export_pages_as_images(&bytes, &[1], &jpg_dir, "sample", "jpeg", 72, None)
        .unwrap();
    assert_eq!(jpg_paths.len(), 1);
    let jpg0 = std::fs::read(&jpg_paths[0]).unwrap();
    assert_eq!(&jpg0[0..3], &[0xFF, 0xD8, 0xFF]);
    let decoded_jpg = image::load_from_memory(&jpg0).unwrap();
    assert_eq!(decoded_jpg.width(), 612);
}

#[test]
fn test_apply_area_redactions_text_and_image_batch() {
    let mut doc = Document::with_version("1.5");
    let pages_id = doc.new_object_id();
    let font_id = doc.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type1",
        "BaseFont" => "Helvetica",
    });

    // 2x2 red image XObject
    let img_id = doc.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Image",
            "Width" => 2,
            "Height" => 2,
            "ColorSpace" => "DeviceRGB",
            "BitsPerComponent" => 8,
        },
        vec![255, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0],
    ));

    let resources_id = doc.add_object(dictionary! {
        "Font" => dictionary! { "F1" => font_id },
        "XObject" => dictionary! { "ImSecret" => img_id },
    });

    let p0_ops = vec![
        Operation::new("BT", vec![]),
        Operation::new("Tf", vec!["F1".into(), 14.into()]),
        Operation::new("Td", vec![72.into(), 700.into()]),
        Operation::new("Tj", vec![Object::string_literal("PUBLIC_HEADER")]),
        Operation::new("ET", vec![]),
        Operation::new("BT", vec![]),
        Operation::new("Tf", vec!["F1".into(), 14.into()]),
        Operation::new("Td", vec![72.into(), 500.into()]),
        Operation::new("Tj", vec![Object::string_literal("SECRET_SSN_99999")]),
        Operation::new("ET", vec![]),
        Operation::new("BT", vec![]),
        Operation::new("Tf", vec!["F1".into(), 14.into()]),
        Operation::new("Td", vec![72.into(), 400.into()]),
        Operation::new(
            "TJ",
            vec![Object::Array(vec![
                Object::string_literal("VISIBLE_"),
                Object::string_literal("HIDDEN_TOKEN"),
            ])],
        ),
        Operation::new("ET", vec![]),
        Operation::new("q", vec![]),
        Operation::new(
            "cm",
            vec![100.into(), 0.into(), 0.into(), 80.into(), 120.into(), 200.into()],
        ),
        Operation::new("Do", vec!["ImSecret".into()]),
        Operation::new("Q", vec![]),
    ];

    let p0_stream = doc.add_object(Stream::new(
        dictionary! {},
        Content { operations: p0_ops }.encode().unwrap(),
    ));
    let p1_ops = vec![
        Operation::new("BT", vec![]),
        Operation::new("Tf", vec!["F1".into(), 14.into()]),
        Operation::new("Td", vec![72.into(), 600.into()]),
        Operation::new("Tj", vec![Object::string_literal("PAGE2_CONFIDENTIAL")]),
        Operation::new("ET", vec![]),
    ];
    let p1_stream = doc.add_object(Stream::new(
        dictionary! {},
        Content { operations: p1_ops }.encode().unwrap(),
    ));

    let p0_id = doc.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
        "Contents" => p0_stream,
        "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
    });
    let p1_id = doc.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
        "Contents" => p1_stream,
        "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
    });

    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => vec![Object::Reference(p0_id), Object::Reference(p1_id)],
            "Count" => 2,
            "Resources" => resources_id,
            "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
        }),
    );
    let catalog_id = doc.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
    });
    doc.trailer.set("Root", catalog_id);

    let mut initial_bytes = Vec::new();
    doc.save_to(&mut initial_bytes).unwrap();
    let mut state = DocumentState::from_bytes(&initial_bytes).unwrap();

    // Redact SECRET_SSN_99999 (y~500), HIDDEN_TOKEN (starts around x = 72 + 8*14*0.55 = ~133.6, y~400),
    // image at (120, 200, 100, 80), and PAGE2_CONFIDENTIAL (y~600)
    let items = vec![
        AreaRedactItem {
            page_index: 0,
            rect: PageBox::new(65.0, 490.0, 220.0, 30.0),
        },
        AreaRedactItem {
            page_index: 0,
            rect: PageBox::new(135.0, 390.0, 180.0, 30.0),
        },
        AreaRedactItem {
            page_index: 0,
            rect: PageBox::new(115.0, 195.0, 110.0, 90.0),
        },
        AreaRedactItem {
            page_index: 1,
            rect: PageBox::new(65.0, 590.0, 240.0, 30.0),
        },
    ];

    apply_area_redactions(&mut state, &items).unwrap();

    let out_bytes = state.to_bytes().unwrap();
    let raw = String::from_utf8_lossy(&out_bytes);
    assert!(!raw.contains("SECRET_SSN_99999"));
    assert!(!raw.contains("HIDDEN_TOKEN"));
    assert!(!raw.contains("PAGE2_CONFIDENTIAL"));
    assert!(raw.contains("PUBLIC_HEADER"));
    assert!(raw.contains("VISIBLE_"));

    // Verify Do for ImSecret was removed
    let p0_content = state.doc.get_page_content(state.get_page_id(0).unwrap());
    let p0_str = String::from_utf8_lossy(&p0_content);
    assert!(!p0_str.contains("ImSecret"));

    let renderer = PdfRenderer::new().unwrap();
    let p0_text = renderer.extract_page_text(&out_bytes, 0, None).unwrap();
    assert!(p0_text.contains("PUBLIC_HEADER"));
    assert!(p0_text.contains("VISIBLE_"));
    assert!(!p0_text.contains("SECRET_SSN_99999"));
    assert!(!p0_text.contains("HIDDEN_TOKEN"));

    let p1_text = renderer.extract_page_text(&out_bytes, 1, None).unwrap();
    assert!(!p1_text.contains("PAGE2_CONFIDENTIAL"));

    let reopened = DocumentState::from_bytes(&out_bytes).unwrap();
    assert_eq!(reopened.page_count(), 2);
}

#[test]
fn test_add_image_annotation_with_alpha() {
    let mut img = image::RgbaImage::new(8, 8);
    for (x, y, px) in img.enumerate_pixels_mut() {
        *px = if (x + y) % 2 == 0 {
            image::Rgba([20, 90, 200, 220])
        } else {
            image::Rgba([0, 0, 0, 0])
        };
    }
    let mut png_buf = Vec::new();
    image::DynamicImage::ImageRgba8(img)
        .write_to(&mut std::io::Cursor::new(&mut png_buf), image::ImageFormat::Png)
        .unwrap();
    let data_url = format!("data:image/png;base64,{}", BASE64.encode(&png_buf));
    assert_eq!(decode_image_base64(&data_url).unwrap(), png_buf);

    let mut doc = DocumentState::new_blank(612.0, 792.0).unwrap();
    let mut cmd_mgr = CommandManager::new();
    let annot = AnnotationDto {
        id: "sig-1".into(),
        page_index: 0,
        annot_type: AnnotationType::Image,
        rect: PageBox::new(100.0, 200.0, 120.0, 60.0),
        color: "#000000".into(),
        fill_color: None,
        stroke_width: 0.0,
        opacity: 0.85,
        text: None,
        font_size: None,
        font_family: None,
        points: None,
        author: None,
        modified_date: None,
        locked: false,
        image_base64: Some(data_url),
    };
    cmd_mgr
        .execute(
            &mut doc,
            Box::new(AddAnnotationCommand {
                page_index: 0,
                annotation: annot,
            }),
        )
        .unwrap();

    commit_annotations_to_pdf(&mut doc).unwrap();
    let bytes = doc.to_bytes().unwrap();
    let reopened = DocumentState::from_bytes(&bytes).unwrap();
    let has_image_xobject = reopened.doc.objects.values().any(|obj| {
        obj.as_stream().is_ok_and(|s| {
            s.dict.get(b"Subtype").and_then(|v| v.as_name()).ok() == Some(b"Image")
                && s.dict.get(b"SMask").is_ok()
        })
    });
    assert!(has_image_xobject, "PDF must contain Image XObject with SMask");

    let renderer = PdfRenderer::new().unwrap();
    let rendered = renderer.render_page_raw(&bytes, 0, 600, None).unwrap();
    assert_eq!(&rendered[0..4], &[0x89, b'P', b'N', b'G']);
}

#[test]
fn test_batch_overlay_watermark_page_numbers_bates_invertible() {
    let mut doc = make_text_pdf_doc(&[
        vec![(72.0, 700.0, "DOC_BODY_1")],
        vec![(72.0, 700.0, "DOC_BODY_2")],
        vec![(72.0, 700.0, "DOC_BODY_3")],
    ]);
    let mut cmd_mgr = CommandManager::new();

    cmd_mgr
        .execute(
            &mut doc,
            Box::new(BatchOverlayCommand::new(BatchOverlayOptions {
                kind: OverlayKind::Watermark,
                pages: None,
                text: Some("CONFIDENTIAL".into()),
                position: Some(OverlayPosition::Center),
                font_size: Some(48.0),
                color: Some("#dc2626".into()),
                opacity: Some(0.3),
                rotation: Some(45.0),
                margin: None,
                bates_prefix: None,
                bates_start: None,
                bates_digits: None,
                header_left: None,
                header_center: None,
                header_right: None,
                footer_left: None,
                footer_center: None,
                footer_right: None,
            })),
        )
        .unwrap();

    cmd_mgr
        .execute(
            &mut doc,
            Box::new(BatchOverlayCommand::new(BatchOverlayOptions {
                kind: OverlayKind::PageNumbers,
                pages: None,
                text: Some("Page {page} of {total}".into()),
                position: Some(OverlayPosition::BottomCenter),
                font_size: Some(10.0),
                color: None,
                opacity: Some(1.0),
                rotation: None,
                margin: Some(24.0),
                bates_prefix: None,
                bates_start: None,
                bates_digits: None,
                header_left: None,
                header_center: None,
                header_right: None,
                footer_left: None,
                footer_center: None,
                footer_right: None,
            })),
        )
        .unwrap();

    cmd_mgr
        .execute(
            &mut doc,
            Box::new(BatchOverlayCommand::new(BatchOverlayOptions {
                kind: OverlayKind::Bates,
                pages: Some(vec![0, 2]),
                text: None,
                position: Some(OverlayPosition::BottomRight),
                font_size: Some(10.0),
                color: None,
                opacity: None,
                rotation: None,
                margin: Some(24.0),
                bates_prefix: Some("CASE-".into()),
                bates_start: Some(100),
                bates_digits: Some(5),
                header_left: None,
                header_center: None,
                header_right: None,
                footer_left: None,
                footer_center: None,
                footer_right: None,
            })),
        )
        .unwrap();

    let renderer = PdfRenderer::new().unwrap();
    let bytes = doc.to_bytes().unwrap();
    let p0 = renderer.extract_page_text(&bytes, 0, None).unwrap();
    let p1 = renderer.extract_page_text(&bytes, 1, None).unwrap();
    let p2 = renderer.extract_page_text(&bytes, 2, None).unwrap();

    assert!(p0.contains("CONFIDENTIAL"));
    assert!(p0.contains("Page 1 of 3"));
    assert!(p0.contains("CASE-00100"));

    assert!(p1.contains("Page 2 of 3"));
    assert!(!p1.contains("CASE-"));

    assert!(p2.contains("Page 3 of 3"));
    assert!(p2.contains("CASE-00101"));

    // Undo all 3 overlays
    cmd_mgr.undo(&mut doc).unwrap();
    cmd_mgr.undo(&mut doc).unwrap();
    cmd_mgr.undo(&mut doc).unwrap();

    let undone_bytes = doc.to_bytes().unwrap();
    let p0_undone = renderer.extract_page_text(&undone_bytes, 0, None).unwrap();
    assert!(!p0_undone.contains("CONFIDENTIAL"));
    assert!(!p0_undone.contains("Page 1 of 3"));
    assert!(!p0_undone.contains("CASE-00100"));
    assert!(p0_undone.contains("DOC_BODY_1"));
}

#[test]
fn test_get_document_outline_hierarchy() {
    let mut state = make_text_pdf_doc(&[
        vec![(72.0, 700.0, "Ch 1")],
        vec![(72.0, 700.0, "Sec 1.1")],
        vec![(72.0, 700.0, "Ch 2")],
    ]);
    let p0 = state.get_page_id(0).unwrap();
    let p1 = state.get_page_id(1).unwrap();
    let p2 = state.get_page_id(2).unwrap();

    let outlines_id = state.doc.new_object_id();
    let ch1_id = state.doc.new_object_id();
    let sec11_id = state.doc.new_object_id();
    let ch2_id = state.doc.new_object_id();

    // UTF-16BE BOM title for Section 1.1
    let mut utf16_title = vec![0xFE, 0xFF];
    for unit in "Section 1.1 — Résumé".encode_utf16() {
        utf16_title.extend_from_slice(&unit.to_be_bytes());
    }

    state.doc.objects.insert(
        sec11_id,
        Object::Dictionary(dictionary! {
            "Title" => Object::String(utf16_title, lopdf::StringFormat::Hexadecimal),
            "Parent" => ch1_id,
            "Dest" => vec![Object::Reference(p1), Object::Name(b"Fit".to_vec())],
        }),
    );
    state.doc.objects.insert(
        ch1_id,
        Object::Dictionary(dictionary! {
            "Title" => Object::string_literal("Chapter 1"),
            "Parent" => outlines_id,
            "First" => sec11_id,
            "Last" => sec11_id,
            "Next" => ch2_id,
            "Dest" => vec![Object::Reference(p0), Object::Name(b"Fit".to_vec())],
        }),
    );
    state.doc.objects.insert(
        ch2_id,
        Object::Dictionary(dictionary! {
            "Title" => Object::string_literal("Chapter 2"),
            "Parent" => outlines_id,
            "Prev" => ch1_id,
            "A" => dictionary! {
                "S" => "GoTo",
                "D" => vec![Object::Reference(p2), Object::Name(b"Fit".to_vec())],
            },
        }),
    );
    state.doc.objects.insert(
        outlines_id,
        Object::Dictionary(dictionary! {
            "Type" => "Outlines",
            "First" => ch1_id,
            "Last" => ch2_id,
            "Count" => 3,
        }),
    );

    let root_id = state
        .doc
        .trailer
        .get(b"Root")
        .unwrap()
        .as_reference()
        .unwrap();
    state
        .doc
        .get_dictionary_mut(root_id)
        .unwrap()
        .set("Outlines", outlines_id);

    let outline = state.get_outline().unwrap();
    assert_eq!(outline.len(), 2);
    assert_eq!(outline[0].title, "Chapter 1");
    assert_eq!(outline[0].page_index, Some(0));
    assert_eq!(outline[0].children.len(), 1);
    assert_eq!(outline[0].children[0].title, "Section 1.1 — Résumé");
    assert_eq!(outline[0].children[0].page_index, Some(1));
    assert_eq!(outline[1].title, "Chapter 2");
    assert_eq!(outline[1].page_index, Some(2));
}

#[test]
fn test_detect_crop_margins() {
    // Page 0: rectangle strictly at PDF coords (150, 250, 200, 300)
    // Viewport coords for 612x792: x=150, y = 792 - 250 - 300 = 242, w=200, h=300
    let mut doc = DocumentState::new_blank(612.0, 792.0).unwrap();
    doc.insert_blank_page(1, 612.0, 792.0).unwrap();

    let p0_id = doc.get_page_id(0).unwrap();
    let content = Content {
        operations: vec![
            Operation::new("q", vec![]),
            Operation::new("rg", vec![0.1.into(), 0.2.into(), 0.3.into()]),
            Operation::new("re", vec![150.into(), 250.into(), 200.into(), 300.into()]),
            Operation::new("f", vec![]),
            Operation::new("Q", vec![]),
        ],
    };
    let stream_id = doc
        .doc
        .add_object(Stream::new(dictionary! {}, content.encode().unwrap()));
    doc.doc
        .get_dictionary_mut(p0_id)
        .unwrap()
        .set("Contents", stream_id);

    let bytes = doc.to_bytes().unwrap();
    let renderer = PdfRenderer::new().unwrap();

    let box0 = renderer
        .detect_crop_margins(&bytes, 0, 612.0, 792.0, None)
        .unwrap();
    assert!((box0.x - 150.0).abs() <= 8.0, "box0.x = {}", box0.x);
    assert!((box0.y - 242.0).abs() <= 8.0, "box0.y = {}", box0.y);
    assert!((box0.width - 200.0).abs() <= 16.0, "box0.w = {}", box0.width);
    assert!((box0.height - 300.0).abs() <= 16.0, "box0.h = {}", box0.height);

    // Blank page 1 returns full page bounds
    let box1 = renderer
        .detect_crop_margins(&bytes, 1, 612.0, 792.0, None)
        .unwrap();
    assert_eq!(box1, PageBox::new(0.0, 0.0, 612.0, 792.0));
}

#[test]
fn test_pdf_point_to_viewport_roundtrip_all_rotations() {
    let visible = PageBox::new(40.0, 70.0, 500.0, 600.0);
    for (rotation, width, height) in [
        (0, 500.0, 600.0),
        (90, 600.0, 500.0),
        (180, 500.0, 600.0),
        (270, 600.0, 500.0),
    ] {
        let page = PageInfo {
            index: 0,
            rotation,
            width,
            height,
            media_box: PageBox::new(10.0, 20.0, 612.0, 792.0),
            crop_box: Some(visible),
            label: None,
        };
        let original = Point2D { x: 123.5, y: 245.25 };
        let pdf_pt = page.viewport_point(original.x, original.y);
        let roundtrip = page.pdf_point_to_viewport(pdf_pt);
        assert!(
            (roundtrip.x - original.x).abs() < 1e-9 && (roundtrip.y - original.y).abs() < 1e-9,
            "rotation {rotation}: got ({}, {}) expected ({}, {})",
            roundtrip.x,
            roundtrip.y,
            original.x,
            original.y
        );
    }
}

#[test]
fn test_extract_text_spans_and_regex_search_redact() {
    let mut doc = make_text_pdf_doc(&[vec![
        (72.0, 720.0, "Contact alice@example.com for details"),
        (72.0, 690.0, "Ref ID-48291"),
    ]]);
    let bytes = std::sync::Arc::new(doc.to_bytes().unwrap());
    let renderer = PdfRenderer::new().unwrap();

    let spans = renderer
        .extract_page_text_spans_arc(1, std::sync::Arc::clone(&bytes), 0, None)
        .unwrap();
    let joined: String = spans.iter().map(|s| s.text.as_str()).collect::<Vec<_>>().join(" ");
    assert!(joined.contains("alice@example.com"), "spans: {joined}");
    assert!(spans.iter().all(|s| s.rect.width > 0.0 && s.rect.height > 0.0));

    let hits = renderer
        .search_document_regex_arc(
            1,
            std::sync::Arc::clone(&bytes),
            r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}",
            false,
            None,
        )
        .unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].match_text, "alice@example.com");
    assert!(!hits[0].bounding_boxes.is_empty());

    // Bulk redact the regex match
    let items: Vec<AreaRedactItem> = hits
        .iter()
        .flat_map(|h| {
            h.bounding_boxes.iter().map(|&rect| AreaRedactItem {
                page_index: h.page_index,
                rect,
            })
        })
        .collect();
    pdf_core::redaction::apply_area_redactions(&mut doc, &items).unwrap();
    let redacted_bytes = doc.to_bytes().unwrap();
    let after_text = renderer.extract_page_text(&redacted_bytes, 0, None).unwrap();
    assert!(!after_text.contains("alice@example.com"));
}

#[test]
fn test_editable_outline_command_and_undo_redo() {
    let mut doc = DocumentState::new_blank(612.0, 792.0).unwrap();
    doc.insert_blank_page(1, 612.0, 792.0).unwrap();
    let mut cmd_mgr = CommandManager::new();

    let new_outline = vec![
        OutlineItem {
            title: "Chapter 1".to_string(),
            page_index: Some(0),
            children: vec![OutlineItem {
                title: "Section 1.1 — Café".to_string(),
                page_index: Some(1),
                children: vec![],
            }],
        },
        OutlineItem {
            title: "Appendix".to_string(),
            page_index: Some(1),
            children: vec![],
        },
    ];

    cmd_mgr
        .execute(
            &mut doc,
            Box::new(UpdateOutlineCommand {
                previous_outline: vec![],
                new_outline: new_outline.clone(),
            }),
        )
        .unwrap();
    assert_eq!(doc.get_outline().unwrap(), new_outline);

    // Roundtrip through PDF bytes
    let reloaded = DocumentState::from_bytes(&doc.to_bytes().unwrap()).unwrap();
    assert_eq!(reloaded.get_outline().unwrap(), new_outline);

    cmd_mgr.undo(&mut doc).unwrap();
    assert!(doc.get_outline().unwrap().is_empty());

    cmd_mgr.redo(&mut doc).unwrap();
    assert_eq!(doc.get_outline().unwrap(), new_outline);
}

#[test]
fn test_acroform_read_edit_undo_and_flatten() {
    let mut doc_state = DocumentState::new_blank(612.0, 792.0).unwrap();
    let page_id = doc_state.get_page_id(0).unwrap();

    let text_field_id = doc_state.doc.add_object(dictionary! {
        "Type" => "Annot",
        "Subtype" => "Widget",
        "FT" => "Tx",
        "T" => Object::string_literal("full_name"),
        "V" => Object::string_literal("Initial"),
        "Rect" => vec![72.into(), 700.into(), 272.into(), 724.into()],
        "P" => page_id,
    });
    let check_field_id = doc_state.doc.add_object(dictionary! {
        "Type" => "Annot",
        "Subtype" => "Widget",
        "FT" => "Btn",
        "T" => Object::string_literal("agree"),
        "V" => Object::Name(b"Off".to_vec()),
        "AS" => Object::Name(b"Off".to_vec()),
        "Rect" => vec![72.into(), 660.into(), 90.into(), 678.into()],
        "P" => page_id,
    });
    let dropdown_id = doc_state.doc.add_object(dictionary! {
        "Type" => "Annot",
        "Subtype" => "Widget",
        "FT" => "Ch",
        "Ff" => 1 << 17,
        "T" => Object::string_literal("country"),
        "Opt" => vec![Object::string_literal("US"), Object::string_literal("CA")],
        "V" => Object::string_literal("US"),
        "Rect" => vec![72.into(), 620.into(), 200.into(), 642.into()],
        "P" => page_id,
    });

    doc_state
        .doc
        .get_dictionary_mut(page_id)
        .unwrap()
        .set("Annots", vec![text_field_id.into(), check_field_id.into(), dropdown_id.into()]);
    let root_id = doc_state.doc.trailer.get(b"Root").unwrap().as_reference().unwrap();
    doc_state.doc.get_dictionary_mut(root_id).unwrap().set(
        "AcroForm",
        dictionary! {
            "Fields" => vec![text_field_id.into(), check_field_id.into(), dropdown_id.into()],
        },
    );

    let fields = pdf_core::forms::extract_form_fields(&doc_state).unwrap();
    assert_eq!(fields.len(), 3);
    assert_eq!(fields[0].field_type, FormFieldType::Text);
    assert_eq!(fields[0].value, "Initial");
    assert_eq!(fields[1].field_type, FormFieldType::Checkbox);
    assert_eq!(fields[1].value, "false");
    assert_eq!(fields[2].field_type, FormFieldType::Dropdown);
    assert_eq!(fields[2].options, vec!["US", "CA"]);

    let mut cmd_mgr = CommandManager::new();
    cmd_mgr
        .execute(
            &mut doc_state,
            Box::new(SetFormFieldCommand {
                field_id: fields[0].id.clone(),
                old_value: "Initial".to_string(),
                new_value: "Jane Doe".to_string(),
                page_index: 0,
            }),
        )
        .unwrap();
    cmd_mgr
        .execute(
            &mut doc_state,
            Box::new(SetFormFieldCommand {
                field_id: fields[1].id.clone(),
                old_value: "false".to_string(),
                new_value: "true".to_string(),
                page_index: 0,
            }),
        )
        .unwrap();

    let updated = pdf_core::forms::extract_form_fields(&doc_state).unwrap();
    assert_eq!(updated[0].value, "Jane Doe");
    assert_eq!(updated[1].value, "true");

    cmd_mgr.undo(&mut doc_state).unwrap();
    let after_undo = pdf_core::forms::extract_form_fields(&doc_state).unwrap();
    assert_eq!(after_undo[1].value, "false");

    let affected = pdf_core::forms::flatten_form_fields(&mut doc_state).unwrap();
    assert_eq!(affected, vec![0]);
    assert!(pdf_core::forms::extract_form_fields(&doc_state).unwrap().is_empty());
}

#[test]
fn test_extract_page_links_internal_and_uri() {
    let mut doc_state = DocumentState::new_blank(612.0, 792.0).unwrap();
    doc_state.insert_blank_page(1, 612.0, 792.0).unwrap();
    let p0 = doc_state.get_page_id(0).unwrap();
    let p1 = doc_state.get_page_id(1).unwrap();

    let uri_action = doc_state.doc.add_object(dictionary! {
        "S" => "URI",
        "URI" => Object::string_literal("https://example.com/docs"),
    });
    let uri_link = doc_state.doc.add_object(dictionary! {
        "Type" => "Annot",
        "Subtype" => "Link",
        "Rect" => vec![72.into(), 700.into(), 200.into(), 720.into()],
        "A" => uri_action,
    });
    let goto_link = doc_state.doc.add_object(dictionary! {
        "Type" => "Annot",
        "Subtype" => "Link",
        "Rect" => vec![72.into(), 660.into(), 200.into(), 680.into()],
        "Dest" => vec![p1.into(), Object::Name(b"Fit".to_vec())],
    });
    doc_state
        .doc
        .get_dictionary_mut(p0)
        .unwrap()
        .set("Annots", vec![uri_link.into(), goto_link.into()]);

    let bytes = std::sync::Arc::new(doc_state.to_bytes().unwrap());
    let renderer = PdfRenderer::new().unwrap();
    let links = renderer.extract_page_links_arc(1, bytes, 0, None).unwrap();
    assert_eq!(links.len(), 2);
    assert!(links.iter().any(|l| l.uri.as_deref() == Some("https://example.com/docs")));
    assert!(links.iter().any(|l| l.target_page == Some(1)));
}
