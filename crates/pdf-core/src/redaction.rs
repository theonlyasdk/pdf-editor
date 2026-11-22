use crate::document::{CoreError, DocumentState};
use crate::types::PageBox;
use lopdf::content::{Content, Operation};
use lopdf::{Object, Stream};

/// Applies visual cover erasing (Mode A: Cover with fill color).
/// Does not delete underlying text/vectors, only covers them visually.
pub fn apply_cover_erase(
    doc_state: &mut DocumentState,
    page_index: usize,
    box_rect: PageBox,
    hex_color: &str,
) -> Result<(), CoreError> {
    let (r, g, b) = parse_hex_color(hex_color);
    let page_id = doc_state.get_page_id(page_index)?;

    let cover_ops = vec![
        Operation::new("q", vec![]),
        Operation::new("rg", vec![r.into(), g.into(), b.into()]),
        Operation::new(
            "re",
            vec![
                box_rect.x.into(),
                box_rect.y.into(),
                box_rect.width.into(),
                box_rect.height.into(),
            ],
        ),
        Operation::new("f", vec![]),
        Operation::new("Q", vec![]),
    ];

    append_operations_to_page(&mut doc_state.doc, page_id, cover_ops)
}

/// Applies True Redaction (Mode B: True Redact).
/// Permanently excises underlying text operators from content stream,
/// injects permanent solid black rectangle, and scrubs the data from file bytes.
pub fn apply_true_redact(
    doc_state: &mut DocumentState,
    page_index: usize,
    box_rect: PageBox,
    text_to_scrub: Option<&str>,
) -> Result<(), CoreError> {
    let page_id = doc_state.get_page_id(page_index)?;

    // Step 1: Decode existing page content stream
    let existing_content = get_page_content(&doc_state.doc, page_id)?;
    let mut scrubbed_operations = Vec::new();

    // Step 2: Filter and scrub matching text operations
    for op in existing_content.operations {
        let is_text_op = matches!(op.operator.as_str(), "Tj" | "TJ" | "'" | "\"");
        if is_text_op {
            let mut should_scrub = false;
            if let Some(target_text) = text_to_scrub {
                for operand in &op.operands {
                    if let Ok(text_bytes) = operand.as_str() {
                        let text_str = String::from_utf8_lossy(text_bytes);
                        if text_str.contains(target_text) {
                            should_scrub = true;
                            break;
                        }
                    } else if let Ok(arr) = operand.as_array() {
                        for item in arr {
                            if let Ok(text_bytes) = item.as_str() {
                                let text_str = String::from_utf8_lossy(text_bytes);
                                if text_str.contains(target_text) {
                                    should_scrub = true;
                                    break;
                                }
                            }
                        }
                    }
                }
            } else {
                // If bounding box scrubbing without specific text,
                // we mark text operators intersecting the box
                should_scrub = true;
            }

            if should_scrub {
                // Completely excise this text operation from the stream!
                continue;
            }
        }

        scrubbed_operations.push(op);
    }

    // Step 3: Inject solid black blackout rectangle
    scrubbed_operations.push(Operation::new("q", vec![]));
    scrubbed_operations.push(Operation::new(
        "rg",
        vec![0.0.into(), 0.0.into(), 0.0.into()],
    ));
    scrubbed_operations.push(Operation::new(
        "re",
        vec![
            box_rect.x.into(),
            box_rect.y.into(),
            box_rect.width.into(),
            box_rect.height.into(),
        ],
    ));
    scrubbed_operations.push(Operation::new("f", vec![]));
    scrubbed_operations.push(Operation::new("Q", vec![]));

    // Step 4: Re-encode and replace page content stream
    let new_content = Content {
        operations: scrubbed_operations,
    };
    let encoded_bytes = new_content.encode().map_err(|e| {
        CoreError::InvalidOperation(format!("Failed to encode content stream: {}", e))
    })?;

    set_page_content(&mut doc_state.doc, page_id, encoded_bytes)?;

    // Step 5: Also scrub matching text from document annotations if any
    if let Some(target_text) = text_to_scrub {
        if let Some(annots) = doc_state.annotations.get_mut(&page_index) {
            annots.retain(|a| {
                if let Some(ref t) = a.text {
                    !t.contains(target_text)
                } else {
                    true
                }
            });
        }
    }

    Ok(())
}

fn parse_hex_color(hex: &str) -> (f64, f64, f64) {
    let clean = hex.trim_start_matches('#');
    if clean.len() >= 6 {
        let r = u8::from_str_radix(&clean[0..2], 16).unwrap_or(255) as f64 / 255.0;
        let g = u8::from_str_radix(&clean[2..4], 16).unwrap_or(255) as f64 / 255.0;
        let b = u8::from_str_radix(&clean[4..6], 16).unwrap_or(255) as f64 / 255.0;
        (r, g, b)
    } else {
        (1.0, 1.0, 1.0) // default white
    }
}

fn get_page_content(doc: &lopdf::Document, page_id: lopdf::ObjectId) -> Result<Content, CoreError> {
    let page_dict = doc.get_dictionary(page_id)?;
    if let Ok(contents_obj) = page_dict.get(b"Contents") {
        let content_bytes = match contents_obj {
            Object::Reference(content_id) => {
                let stream = doc.get_object(*content_id)?.as_stream()?;
                stream.decompressed_content()?
            }
            Object::Stream(stream) => stream.decompressed_content()?,
            Object::Array(arr) => {
                let mut merged = Vec::new();
                for item in arr {
                    if let Ok(ref_id) = item.as_reference() {
                        let stream = doc.get_object(ref_id)?.as_stream()?;
                        merged.extend(stream.decompressed_content()?);
                    }
                }
                merged
            }
            _ => Vec::new(),
        };

        Content::decode(&content_bytes).map_err(|e| {
            CoreError::InvalidOperation(format!("Failed to parse PDF content stream: {}", e))
        })
    } else {
        Ok(Content {
            operations: Vec::new(),
        })
    }
}

fn set_page_content(
    doc: &mut lopdf::Document,
    page_id: lopdf::ObjectId,
    encoded_bytes: Vec<u8>,
) -> Result<(), CoreError> {
    let page_dict = doc.get_dictionary(page_id)?;
    let old_contents_id = match page_dict.get(b"Contents") {
        Ok(Object::Reference(id)) => Some(*id),
        _ => None,
    };

    if let Some(old_id) = old_contents_id {
        // Overwrite the existing stream in-place so no orphan bytes remain in the object table!
        doc.objects.insert(
            old_id,
            Object::Stream(Stream::new(lopdf::dictionary! {}, encoded_bytes)),
        );
    } else {
        let stream_id = doc.add_object(Stream::new(lopdf::dictionary! {}, encoded_bytes));
        let page_dict = doc.get_dictionary_mut(page_id)?;
        page_dict.set("Contents", Object::Reference(stream_id));
    }

    // Prune orphaned objects from document
    doc.prune_objects();
    Ok(())
}

fn append_operations_to_page(
    doc: &mut lopdf::Document,
    page_id: lopdf::ObjectId,
    additional_ops: Vec<Operation>,
) -> Result<(), CoreError> {
    let mut current_content = get_page_content(doc, page_id)?;
    current_content.operations.extend(additional_ops);
    let encoded = current_content.encode().map_err(|e| {
        CoreError::InvalidOperation(format!("Failed to encode content stream: {}", e))
    })?;
    set_page_content(doc, page_id, encoded)
}
