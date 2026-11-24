use pdf_core::commands::*;
use pdf_core::document::DocumentState;
use pdf_core::persistence::safe_save;
use pdf_core::range_parser::parse_page_range;
use pdf_core::redaction::{apply_cover_erase, apply_true_redact};
use pdf_core::renderer::PdfRenderer;
use pdf_core::types::*;
use std::fs;
use tempfile::tempdir;

#[test]
fn test_end_to_end_full_user_workflow() {
    let dir = tempdir().unwrap();
    let original_path = dir.path().join("workflow_input.pdf");
    let target_save_path = dir.path().join("workflow_saved.pdf");

    // Step 1: Open/Create initial document with text
    let mut doc = DocumentState::new_blank(612.0, 792.0).unwrap();
    safe_save(&mut doc, &original_path, false).unwrap();

    let mut doc = DocumentState::from_file(&original_path).unwrap();
    assert_eq!(doc.page_count(), 1);

    let mut cmd_mgr = CommandManager::new();

    // Step 2: Insert two more pages
    let insert_cmd1 = Box::new(InsertBlankPageCommand {
        at_index: 1,
        width: 612.0,
        height: 792.0,
    });
    cmd_mgr.execute(&mut doc, insert_cmd1).unwrap();

    let insert_cmd2 = Box::new(InsertBlankPageCommand {
        at_index: 2,
        width: 612.0,
        height: 792.0,
    });
    cmd_mgr.execute(&mut doc, insert_cmd2).unwrap();
    assert_eq!(doc.page_count(), 3);

    // Step 3: Programmatic selection expression: "1-3, !2" -> pages 0 and 2
    let selected = parse_page_range("1-3, !2", doc.page_count()).unwrap();
    assert_eq!(selected, vec![0, 2]);

    // Step 4: Rotate selected pages by 90 degrees
    let rotate_cmd = Box::new(RotatePagesCommand {
        pages: selected.clone(),
        delta_deg: 90,
    });
    cmd_mgr.execute(&mut doc, rotate_cmd).unwrap();
    assert_eq!(doc.get_page_info(0).unwrap().rotation, 90);
    assert_eq!(doc.get_page_info(2).unwrap().rotation, 90);

    // Step 5: Crop Page 0 with non-destructive CropBox
    let crop_box = PageBox::new(36.0, 36.0, 540.0, 720.0);
    let crop_cmd = Box::new(CropPagesCommand {
        pages: vec![0],
        previous_boxes: vec![None],
        new_boxes: vec![Some(crop_box)],
    });
    cmd_mgr.execute(&mut doc, crop_cmd).unwrap();
    assert_eq!(doc.get_page_info(0).unwrap().crop_box, Some(crop_box));

    // Step 6: Add Ink annotation
    let ink_annot = AnnotationDto {
        id: "ink-1".into(),
        page_index: 0,
        annot_type: AnnotationType::Ink,
        rect: PageBox::new(100.0, 100.0, 200.0, 100.0),
        color: "#2563eb".into(),
        fill_color: None,
        stroke_width: 3.0,
        opacity: 1.0,
        text: None,
        font_size: None,
        font_family: None,
        points: Some(vec![vec![
            Point2D { x: 100.0, y: 100.0 },
            Point2D { x: 200.0, y: 150.0 },
            Point2D { x: 300.0, y: 200.0 },
        ]]),
        author: Some("Lead Editor".into()),
        modified_date: None,
        locked: false,
        image_base64: None,
    };
    cmd_mgr
        .execute(
            &mut doc,
            Box::new(AddAnnotationCommand {
                page_index: 0,
                annotation: ink_annot,
            }),
        )
        .unwrap();

    // Step 7: Add FreeText annotation
    let text_annot = AnnotationDto {
        id: "text-1".into(),
        page_index: 0,
        annot_type: AnnotationType::FreeText,
        rect: PageBox::new(120.0, 300.0, 250.0, 40.0),
        color: "#0f172a".into(),
        fill_color: None,
        stroke_width: 1.0,
        opacity: 1.0,
        text: Some("CONFIDENTIAL REVIEW COMPLETE".into()),
        font_size: None,
        font_family: None,
        points: None,
        author: Some("Lead Editor".into()),
        modified_date: None,
        locked: false,
        image_base64: None,
    };
    cmd_mgr
        .execute(
            &mut doc,
            Box::new(AddAnnotationCommand {
                page_index: 0,
                annotation: text_annot,
            }),
        )
        .unwrap();

    // Step 8: Apply Cover Erase on Page 0
    let cover_box = PageBox::new(50.0, 50.0, 200.0, 40.0);
    apply_cover_erase(&mut doc, 0, cover_box, "#ffffff").unwrap();

    // Step 9: Inject a secret and execute True Redaction on Page 1
    let secret_to_scrub = "PATIENT_SSN_987-65-4321";
    let stream_content = lopdf::content::Content {
        operations: vec![
            lopdf::content::Operation::new("BT", vec![]),
            lopdf::content::Operation::new("Tf", vec!["Helvetica".into(), 14.into()]),
            lopdf::content::Operation::new("Td", vec![100.into(), 500.into()]),
            lopdf::content::Operation::new(
                "Tj",
                vec![lopdf::Object::string_literal(secret_to_scrub)],
            ),
            lopdf::content::Operation::new("ET", vec![]),
        ],
    };
    let page1_id = doc.get_page_id(1).unwrap();
    let stream_id = doc.doc.add_object(lopdf::Stream::new(
        lopdf::dictionary! {},
        stream_content.encode().unwrap(),
    ));
    doc.doc
        .get_dictionary_mut(page1_id)
        .unwrap()
        .set("Contents", lopdf::Object::Reference(stream_id));

    // True Redact the secret
    let redact_box = PageBox::new(90.0, 490.0, 300.0, 30.0);
    apply_true_redact(&mut doc, 1, redact_box, Some(secret_to_scrub)).unwrap();

    // Step 10: Test Undo and Redo
    assert!(cmd_mgr.can_undo());
    let undone = cmd_mgr.undo(&mut doc).unwrap();
    assert_eq!(undone, Some("Add FreeText Annotation".into()));
    // FreeText annotation was popped from Page 0
    assert_eq!(doc.annotations.get(&0).unwrap().len(), 1);

    // Redo
    assert!(cmd_mgr.can_redo());
    let redone = cmd_mgr.redo(&mut doc).unwrap();
    assert_eq!(redone, Some("Add FreeText Annotation".into()));
    assert_eq!(doc.annotations.get(&0).unwrap().len(), 2);

    // Step 11: Commit annotations to PDF objects and Safe Save with backup
    pdf_core::annotations::commit_annotations_to_pdf(&mut doc).unwrap();
    safe_save(&mut doc, &target_save_path, true).unwrap();

    // Verify physical file on disk
    assert!(target_save_path.exists());
    let saved_file_bytes = fs::read(&target_save_path).unwrap();

    // Verify True Redaction removed secret from raw file bytes
    let raw_str = String::from_utf8_lossy(&saved_file_bytes);
    assert!(
        !raw_str.contains(secret_to_scrub),
        "Redacted sensitive string must not exist in physical file bytes"
    );

    // Step 12: Reopen saved file with independent engine (PdfRenderer / Pdfium)
    let renderer = PdfRenderer::new().unwrap();
    let re_extracted_text_p1 = renderer
        .extract_page_text(&saved_file_bytes, 1, None)
        .unwrap();
    assert!(
        !re_extracted_text_p1.contains(secret_to_scrub),
        "Redacted secret must be completely absent from Pdfium text extraction"
    );

    // Render page 0 and verify valid PNG output
    let page0_png = renderer
        .render_page_raw(&saved_file_bytes, 0, 1000, None)
        .unwrap();
    assert!(!page0_png.is_empty());
    assert_eq!(&page0_png[0..4], &[0x89, b'P', b'N', b'G']);

    // Reopen with DocumentState and verify metadata, page count, and rotation
    let reopened_doc = DocumentState::from_file(&target_save_path).unwrap();
    assert_eq!(reopened_doc.page_count(), 3);
    assert_eq!(reopened_doc.get_page_info(0).unwrap().rotation, 90);
    assert_eq!(reopened_doc.get_page_info(1).unwrap().rotation, 0);
    assert_eq!(reopened_doc.get_page_info(2).unwrap().rotation, 90);
    assert_eq!(
        reopened_doc.get_page_info(0).unwrap().crop_box,
        Some(crop_box)
    );

    println!("=== END-TO-END WORKFLOW VERIFIED 100% ===");
}
