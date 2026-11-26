use pdf_core::commands::*;
use pdf_core::document::DocumentState;
use pdf_core::persistence::safe_save;
use pdf_core::range_parser::parse_page_range;
use pdf_core::redaction::apply_true_redact;
use pdf_core::types::*;
use tempfile::tempdir;

#[test]
fn test_range_parser_comprehensive() {
    let total = 20;

    // Normal ranges and individual numbers
    assert_eq!(
        parse_page_range("1, 3, 5-8", total).unwrap(),
        vec![0, 2, 4, 5, 6, 7]
    );

    // Keywords
    assert_eq!(parse_page_range("odd", 5).unwrap(), vec![0, 2, 4]);
    assert_eq!(parse_page_range("even", 5).unwrap(), vec![1, 3]);
    assert_eq!(parse_page_range("last", 5).unwrap(), vec![4]);
    assert_eq!(parse_page_range("last-2", 5).unwrap(), vec![2]);
    assert_eq!(
        parse_page_range("15-end", total).unwrap(),
        vec![14, 15, 16, 17, 18, 19]
    );

    // Step syntax: 1-10 with step 2 -> 1, 3, 5, 7, 9 -> [0, 2, 4, 6, 8]
    assert_eq!(
        parse_page_range("1-10/2", total).unwrap(),
        vec![0, 2, 4, 6, 8]
    );

    // Negations
    assert_eq!(
        parse_page_range("1-5, !3", total).unwrap(),
        vec![0, 1, 3, 4]
    );
    assert_eq!(parse_page_range("!odd", 4).unwrap(), vec![1, 3]);

    // Complex combination from user specification
    let complex = parse_page_range("1-5, 8, 18-end, !3, 1-10/4", total).unwrap();
    // 1-5 without 3: 0, 1, 3, 4
    // 8: 7
    // 18-20: 17, 18, 19
    // 1-10/4: 1, 5, 9 -> 0, 4, 8
    // Merged: 0, 1, 3, 4, 7, 8, 17, 18, 19
    assert_eq!(complex, vec![0, 1, 3, 4, 7, 8, 17, 18, 19]);
}

#[test]
fn test_page_operations_and_invertibility() {
    let mut doc = DocumentState::new_blank(612.0, 792.0).unwrap();
    assert_eq!(doc.page_count(), 1);

    // Insert 2 more blank pages
    doc.insert_blank_page(1, 612.0, 792.0).unwrap();
    doc.insert_blank_page(2, 612.0, 792.0).unwrap();
    assert_eq!(doc.page_count(), 3);

    let mut cmd_mgr = CommandManager::new();

    // 1. Rotate command
    let rotate_cmd = Box::new(RotatePagesCommand {
        pages: vec![0],
        delta_deg: 90,
    });
    cmd_mgr.execute(&mut doc, rotate_cmd).unwrap();
    assert_eq!(doc.get_page_info(0).unwrap().rotation, 90);

    // Undo rotate
    cmd_mgr.undo(&mut doc).unwrap();
    assert_eq!(doc.get_page_info(0).unwrap().rotation, 0);

    // Redo rotate
    cmd_mgr.redo(&mut doc).unwrap();
    assert_eq!(doc.get_page_info(0).unwrap().rotation, 90);

    // 2. Crop command
    let crop_cmd = Box::new(CropPagesCommand {
        pages: vec![0],
        previous_boxes: vec![None],
        new_boxes: vec![Some(PageBox::new(50.0, 50.0, 500.0, 700.0))],
    });
    cmd_mgr.execute(&mut doc, crop_cmd).unwrap();
    assert_eq!(
        doc.get_page_info(0).unwrap().crop_box,
        Some(PageBox::new(50.0, 50.0, 500.0, 700.0))
    );

    // Undo crop
    cmd_mgr.undo(&mut doc).unwrap();
    assert_eq!(doc.get_page_info(0).unwrap().crop_box, None);

    // 3. Reorder command
    let prev_ids = vec![
        doc.get_page_id(0).unwrap(),
        doc.get_page_id(1).unwrap(),
        doc.get_page_id(2).unwrap(),
    ];
    let new_ids = vec![prev_ids[2], prev_ids[1], prev_ids[0]];
    let reorder_cmd = Box::new(ReorderPagesCommand {
        previous_ids: prev_ids,
        new_ids,
    });
    cmd_mgr.execute(&mut doc, reorder_cmd).unwrap();
    // After swapping 0 and 2, original page 0 (which was rotated 90) is now page 2
    assert_eq!(doc.get_page_info(2).unwrap().rotation, 90);

    // Undo reorder
    cmd_mgr.undo(&mut doc).unwrap();
    assert_eq!(doc.get_page_info(0).unwrap().rotation, 90);
}

#[test]
fn test_true_redaction_and_byte_scrubbing() {
    let mut doc = DocumentState::new_blank(612.0, 792.0).unwrap();

    // Add a text stream containing a sensitive secret
    let secret_text = "CONFIDENTIAL_API_KEY_98765";
    let content = lopdf::content::Content {
        operations: vec![
            lopdf::content::Operation::new("BT", vec![]),
            lopdf::content::Operation::new("Tf", vec!["Helvetica".into(), 16.into()]),
            lopdf::content::Operation::new("Td", vec![100.into(), 500.into()]),
            lopdf::content::Operation::new("Tj", vec![lopdf::Object::string_literal(secret_text)]),
            lopdf::content::Operation::new("ET", vec![]),
        ],
    };
    let page_id = doc.get_page_id(0).unwrap();
    let stream_id = doc.doc.add_object(lopdf::Stream::new(
        lopdf::dictionary! {},
        content.encode().unwrap(),
    ));
    doc.doc
        .get_dictionary_mut(page_id)
        .unwrap()
        .set("Contents", lopdf::Object::Reference(stream_id));

    // Verify secret is present in raw bytes
    let raw_bytes_before = doc.to_bytes().unwrap();
    let raw_str_before = String::from_utf8_lossy(&raw_bytes_before);
    assert!(
        raw_str_before.contains(secret_text),
        "Secret text must be present initially"
    );

    // Apply True Redaction on the secret area
    let redact_box = PageBox::new(90.0, 490.0, 300.0, 30.0);
    apply_true_redact(&mut doc, 0, redact_box, Some(secret_text)).unwrap();

    // Verify secret is completely absent from physical PDF bytes!
    let raw_bytes_after = doc.to_bytes().unwrap();
    let raw_str_after = String::from_utf8_lossy(&raw_bytes_after);
    assert!(
        !raw_str_after.contains(secret_text),
        "Redacted secret must be COMPLETELY ABSENT from file bytes"
    );

    // Reopen document to verify it remains valid PDF
    let reopened = DocumentState::from_bytes(&raw_bytes_after).unwrap();
    assert_eq!(reopened.page_count(), 1);
}

#[test]
fn test_safe_atomic_save_and_backup() {
    let dir = tempdir().unwrap();
    let file_path = dir.path().join("test_doc.pdf");

    let mut doc = DocumentState::new_blank(612.0, 792.0).unwrap();
    doc.insert_blank_page(1, 612.0, 792.0).unwrap();
    assert_eq!(doc.page_count(), 2);

    // Initial safe save
    safe_save(&mut doc, &file_path, false).unwrap();
    assert!(file_path.exists());

    // Modify: add another page
    doc.insert_blank_page(2, 612.0, 792.0).unwrap();
    assert_eq!(doc.page_count(), 3);

    // Safe save with backup enabled
    safe_save(&mut doc, &file_path, true).unwrap();
    let bak_path = file_path.with_extension("pdf.bak");
    assert!(bak_path.exists(), "Backup file must be created");

    // Verify backup has 2 pages, target has 3 pages
    let bak_doc = DocumentState::from_file(&bak_path).unwrap();
    assert_eq!(bak_doc.page_count(), 2);

    let current_doc = DocumentState::from_file(&file_path).unwrap();
    assert_eq!(current_doc.page_count(), 3);
}

#[test]
fn test_pdfium_rendering_and_roundtrip() {
    let mut doc = DocumentState::new_blank(612.0, 792.0).unwrap();
    doc.insert_blank_page(1, 612.0, 792.0).unwrap();

    let renderer = pdf_core::renderer::PdfRenderer::new().unwrap();
    let bytes = doc.to_bytes().unwrap();

    // Render page 0
    let png_page_0 = renderer.render_page_raw(&bytes, 0, 800, None).unwrap();
    assert!(!png_page_0.is_empty(), "Rendered PNG must not be empty");
    assert_eq!(
        &png_page_0[0..4],
        &[0x89, b'P', b'N', b'G'],
        "Must be valid PNG header"
    );

    // Add annotation
    let annot = AnnotationDto {
        id: "test-annot-1".to_string(),
        page_index: 0,
        annot_type: AnnotationType::Highlight,
        rect: PageBox::new(100.0, 100.0, 200.0, 50.0),
        color: "#ffff00".to_string(),
        fill_color: Some("#ffff00".to_string()),
        stroke_width: 1.0,
        opacity: 0.5,
        text: Some("Roundtrip highlight".to_string()),
        font_size: None,
        font_family: None,
        points: None,
        author: Some("Tester".to_string()),
        modified_date: None,
        locked: false,
        image_base64: None,
    };
    doc.annotations.entry(0).or_default().push(annot);

    // Commit annotations and verify roundtrip bytes
    pdf_core::annotations::commit_annotations_to_pdf(&mut doc).unwrap();
    let saved_bytes = doc.to_bytes().unwrap();

    // Reopen and re-render with Pdfium
    let reopened_png = renderer
        .render_page_raw(&saved_bytes, 0, 800, None)
        .unwrap();
    assert!(!reopened_png.is_empty());
    assert_eq!(&reopened_png[0..4], &[0x89, b'P', b'N', b'G']);
}

#[test]
fn crop_coordinates_use_the_visible_page_and_pdf_rotation() {
    use pdf_core::types::{PageBox, PageInfo};

    let visible = PageBox::new(40.0, 70.0, 500.0, 600.0);
    for (rotation, width, height, expected) in [
        (0, 500.0, 600.0, PageBox::new(50.0, 610.0, 30.0, 40.0)),
        (90, 600.0, 500.0, PageBox::new(60.0, 80.0, 40.0, 30.0)),
        (180, 500.0, 600.0, PageBox::new(500.0, 90.0, 30.0, 40.0)),
        (270, 600.0, 500.0, PageBox::new(480.0, 630.0, 40.0, 30.0)),
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
        assert_eq!(
            page.viewport_crop(PageBox::new(0.0, 0.0, width, height)),
            Some(visible)
        );
        assert_eq!(
            page.viewport_crop(PageBox::new(10.0, 20.0, 30.0, 40.0)),
            Some(expected)
        );
    }
}

#[test]
fn fixed_crop_scales_contents_and_annotations_without_changing_page_size() {
    use lopdf::{dictionary, Object};
    use pdf_core::resize_crop::ResizeCropPages;

    let mut doc = DocumentState::new_blank(100.0, 200.0).unwrap();
    let id = doc.get_page_id(0).unwrap();
    doc.doc
        .add_page_contents(id, b"10 30 10 10 re f".to_vec())
        .unwrap();
    let annotation = doc.doc.add_object(dictionary! {
        "Type" => "Annot",
        "Subtype" => "Link",
        "Rect" => vec![30.into(), 60.into(), 40.into(), 70.into()],
    });
    doc.doc
        .get_dictionary_mut(id)
        .unwrap()
        .set("Annots", vec![Object::Reference(annotation)]);
    let original = doc.doc.get_page_content(id);
    let mut commands = CommandManager::new();
    let crop = PageBox::new(25.0, 50.0, 50.0, 100.0);
    commands
        .execute(&mut doc, Box::new(ResizeCropPages::new(vec![(0, crop)])))
        .unwrap();

    let page = doc.get_page_info(0).unwrap();
    assert_eq!(
        (page.width, page.height, page.crop_box),
        (100.0, 200.0, None)
    );
    let content = doc.doc.get_page_content(id);
    let operations = lopdf::content::Content::decode(&content)
        .unwrap()
        .operations;
    let operands = |name: &str| {
        operations
            .iter()
            .find(|op| op.operator == name)
            .unwrap()
            .operands
            .iter()
            .map(|value| value.as_float().unwrap())
            .collect::<Vec<_>>()
    };
    assert_eq!(operands("cm"), vec![2.0, 0.0, 0.0, 2.0, -50.0, -100.0]);
    assert_eq!(operands("re"), vec![0.0, 0.0, 100.0, 200.0]);
    let rect = || {
        doc.doc
            .get_dictionary(annotation)
            .unwrap()
            .get(b"Rect")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(|val| val.as_float().unwrap())
            .collect::<Vec<_>>()
    };
    assert_eq!(rect(), vec![10.0, 20.0, 30.0, 40.0]);

    commands.undo(&mut doc).unwrap();
    assert_eq!(doc.doc.get_page_content(id), original);
    commands.redo(&mut doc).unwrap();
    assert_eq!(doc.doc.get_page_content(id), content);
}

#[test]
fn crop_with_rotation_preserves_page_size_and_is_undoable() {
    use pdf_core::resize_crop::ResizeCropPages;

    let mut doc = DocumentState::new_blank(100.0, 200.0).unwrap();
    let id = doc.get_page_id(0).unwrap();
    doc.doc
        .add_page_contents(id, b"10 30 10 10 re f".to_vec())
        .unwrap();

    let mut commands = CommandManager::new();
    let crop = PageBox::new(10.0, 20.0, 80.0, 160.0);
    commands
        .execute(
            &mut doc,
            Box::new(ResizeCropPages::with_rotation(vec![(0, crop, 2.5)])),
        )
        .unwrap();

    let page = doc.get_page_info(0).unwrap();
    assert_eq!((page.width, page.height, page.crop_box), (100.0, 200.0, None));
    let content_bytes = doc.doc.get_page_content(id);
    let text = String::from_utf8_lossy(&content_bytes);
    assert!(text.contains("cm"), "expected transformation matrix in content: {text}");

    commands.undo(&mut doc).unwrap();
    let restored_bytes = doc.doc.get_page_content(id);
    let restored = String::from_utf8_lossy(&restored_bytes);
    assert!(!restored.contains("cm"));
}
