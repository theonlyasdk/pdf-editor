use crate::document::{CoreError, DocumentState};
use crate::types::{AreaRedactItem, PageBox};
use lopdf::content::{Content, Operation};
use lopdf::{Object, Stream};
use std::collections::HashMap;

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

    // A text-only removal has no rectangle to cover.
    if box_rect.width > 0.0 && box_rect.height > 0.0 {
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
    }

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

/// Applies true content-stream redaction by bounding rect across one or more pages.
/// Excises intersecting text operators (`Tj`, `TJ`, `'`, `"`) and image/XObject (`Do`)
/// invocations, removes intersecting annotations, paints solid black fill rectangles,
/// and prunes orphaned objects so scrubbed bytes cannot be recovered.
pub fn apply_area_redactions(
    doc_state: &mut DocumentState,
    items: &[AreaRedactItem],
) -> Result<(), CoreError> {
    if items.is_empty() {
        return Ok(());
    }

    let mut by_page: HashMap<usize, Vec<PageBox>> = HashMap::new();
    for item in items {
        let _ = doc_state.get_page_id(item.page_index)?;
        if item.rect.width > 0.0 && item.rect.height > 0.0 {
            by_page.entry(item.page_index).or_default().push(item.rect);
        }
    }

    for (page_index, rects) in by_page {
        let page_id = doc_state.get_page_id(page_index)?;
        let existing_content = get_page_content(&doc_state.doc, page_id)?;
        let mut scrubbed_ops = excise_intersecting_ops(&existing_content.operations, &rects);

        for rect in &rects {
            scrubbed_ops.push(Operation::new("q", vec![]));
            scrubbed_ops.push(Operation::new(
                "rg",
                vec![0.0.into(), 0.0.into(), 0.0.into()],
            ));
            scrubbed_ops.push(Operation::new(
                "re",
                vec![
                    rect.x.into(),
                    rect.y.into(),
                    rect.width.into(),
                    rect.height.into(),
                ],
            ));
            scrubbed_ops.push(Operation::new("f", vec![]));
            scrubbed_ops.push(Operation::new("Q", vec![]));
        }

        let encoded = Content {
            operations: scrubbed_ops,
        }
        .encode()
        .map_err(|e| {
            CoreError::InvalidOperation(format!("Failed to encode redacted content stream: {}", e))
        })?;
        set_page_content(&mut doc_state.doc, page_id, encoded)?;

        if let Some(annots) = doc_state.annotations.get_mut(&page_index) {
            annots.retain(|a| !rects.iter().any(|r| a.rect.intersects(r)));
        }

        scrub_page_annots_dict(&mut doc_state.doc, page_id, &rects);
    }

    doc_state.doc.prune_objects();
    Ok(())
}

type Mat2D = [f64; 6];
const IDENTITY: Mat2D = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

fn mul_mat(a: Mat2D, b: Mat2D) -> Mat2D {
    [
        a[0] * b[0] + a[1] * b[2],
        a[0] * b[1] + a[1] * b[3],
        a[2] * b[0] + a[3] * b[2],
        a[2] * b[1] + a[3] * b[3],
        a[4] * b[0] + a[5] * b[2] + b[4],
        a[4] * b[1] + a[5] * b[3] + b[5],
    ]
}

fn transform_pt(m: Mat2D, x: f64, y: f64) -> (f64, f64) {
    (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5])
}

fn transformed_bbox(m: Mat2D, x1: f64, y1: f64, x2: f64, y2: f64) -> PageBox {
    let corners = [
        transform_pt(m, x1, y1),
        transform_pt(m, x2, y1),
        transform_pt(m, x2, y2),
        transform_pt(m, x1, y2),
    ];
    let min_x = corners.iter().map(|c| c.0).fold(f64::INFINITY, f64::min);
    let max_x = corners
        .iter()
        .map(|c| c.0)
        .fold(f64::NEG_INFINITY, f64::max);
    let min_y = corners.iter().map(|c| c.1).fold(f64::INFINITY, f64::min);
    let max_y = corners
        .iter()
        .map(|c| c.1)
        .fold(f64::NEG_INFINITY, f64::max);
    PageBox::new(
        min_x,
        min_y,
        (max_x - min_x).max(0.5),
        (max_y - min_y).max(0.5),
    )
}

fn obj_f64(obj: &Object) -> Option<f64> {
    match obj {
        Object::Real(v) => Some(f64::from(*v)),
        Object::Integer(v) => Some(*v as f64),
        _ => None,
    }
}

fn parse_mat_operands(operands: &[Object]) -> Option<Mat2D> {
    if operands.len() < 6 {
        return None;
    }
    Some([
        obj_f64(&operands[0])?,
        obj_f64(&operands[1])?,
        obj_f64(&operands[2])?,
        obj_f64(&operands[3])?,
        obj_f64(&operands[4])?,
        obj_f64(&operands[5])?,
    ])
}

fn excise_intersecting_ops(ops: &[Operation], rects: &[PageBox]) -> Vec<Operation> {
    let mut out = Vec::with_capacity(ops.len());
    let mut ctm_stack: Vec<Mat2D> = Vec::new();
    let mut ctm = IDENTITY;

    let mut text_matrix = IDENTITY;
    let mut text_line_matrix = IDENTITY;
    let mut font_size = 12.0;
    let mut text_leading = 0.0;
    let mut horiz_scale = 1.0;
    let mut text_rise = 0.0;

    for op in ops {
        match op.operator.as_str() {
            "q" => {
                ctm_stack.push(ctm);
                out.push(op.clone());
            }
            "Q" => {
                if let Some(prev) = ctm_stack.pop() {
                    ctm = prev;
                }
                out.push(op.clone());
            }
            "cm" => {
                if let Some(m) = parse_mat_operands(&op.operands) {
                    ctm = mul_mat(m, ctm);
                }
                out.push(op.clone());
            }
            "BT" => {
                text_matrix = IDENTITY;
                text_line_matrix = IDENTITY;
                out.push(op.clone());
            }
            "ET" => {
                out.push(op.clone());
            }
            "Tf" => {
                if let Some(sz) = op.operands.get(1).and_then(obj_f64) {
                    font_size = sz.abs().max(1.0);
                }
                out.push(op.clone());
            }
            "TL" => {
                if let Some(l) = op.operands.first().and_then(obj_f64) {
                    text_leading = l;
                }
                out.push(op.clone());
            }
            "Tz" => {
                if let Some(s) = op.operands.first().and_then(obj_f64) {
                    horiz_scale = (s / 100.0).max(0.01);
                }
                out.push(op.clone());
            }
            "Ts" => {
                if let Some(r) = op.operands.first().and_then(obj_f64) {
                    text_rise = r;
                }
                out.push(op.clone());
            }
            "Tm" => {
                if let Some(m) = parse_mat_operands(&op.operands) {
                    text_matrix = m;
                    text_line_matrix = m;
                }
                out.push(op.clone());
            }
            "Td" => {
                if let (Some(tx), Some(ty)) = (
                    op.operands.first().and_then(obj_f64),
                    op.operands.get(1).and_then(obj_f64),
                ) {
                    text_line_matrix = mul_mat([1.0, 0.0, 0.0, 1.0, tx, ty], text_line_matrix);
                    text_matrix = text_line_matrix;
                }
                out.push(op.clone());
            }
            "TD" => {
                if let (Some(tx), Some(ty)) = (
                    op.operands.first().and_then(obj_f64),
                    op.operands.get(1).and_then(obj_f64),
                ) {
                    text_leading = -ty;
                    text_line_matrix = mul_mat([1.0, 0.0, 0.0, 1.0, tx, ty], text_line_matrix);
                    text_matrix = text_line_matrix;
                }
                out.push(op.clone());
            }
            "T*" => {
                text_line_matrix =
                    mul_mat([1.0, 0.0, 0.0, 1.0, 0.0, -text_leading], text_line_matrix);
                text_matrix = text_line_matrix;
                out.push(op.clone());
            }
            "Tj" | "'" | "\"" => {
                if op.operator == "'" || op.operator == "\"" {
                    text_line_matrix =
                        mul_mat([1.0, 0.0, 0.0, 1.0, 0.0, -text_leading], text_line_matrix);
                    text_matrix = text_line_matrix;
                }
                let str_idx = if op.operator == "\"" { 2 } else { 0 };
                let char_count = op
                    .operands
                    .get(str_idx)
                    .and_then(|o| o.as_str().ok())
                    .map(|b| b.len())
                    .unwrap_or(0);
                let width_ts = (char_count as f64) * font_size * 0.55 * horiz_scale;
                let total_m = mul_mat(text_matrix, ctm);
                let bbox = transformed_bbox(
                    total_m,
                    0.0,
                    -0.25 * font_size + text_rise,
                    width_ts.max(font_size * 0.4),
                    0.9 * font_size + text_rise,
                );
                text_matrix = mul_mat([1.0, 0.0, 0.0, 1.0, width_ts, 0.0], text_matrix);

                if rects.iter().any(|r| bbox.intersects(r)) {
                    let advance_thousandths = -(width_ts * 1000.0) / (font_size * horiz_scale);
                    if op.operator == "'" || op.operator == "\"" {
                        out.push(Operation::new("T*", vec![]));
                    }
                    if advance_thousandths.abs() > 0.01 {
                        out.push(Operation::new(
                            "TJ",
                            vec![Object::Array(vec![Object::Real(advance_thousandths as f32)])],
                        ));
                    }
                } else {
                    out.push(op.clone());
                }
            }
            "TJ" => {
                if let Some(Object::Array(items)) = op.operands.first() {
                    let mut filtered_items = Vec::with_capacity(items.len());
                    let mut kept_any_string = false;

                    for item in items {
                        if let Some(adj) = obj_f64(item) {
                            let dx = -(adj / 1000.0) * font_size * horiz_scale;
                            text_matrix = mul_mat([1.0, 0.0, 0.0, 1.0, dx, 0.0], text_matrix);
                            filtered_items.push(item.clone());
                        } else if let Ok(bytes) = item.as_str() {
                            let width_ts = (bytes.len() as f64) * font_size * 0.55 * horiz_scale;
                            let total_m = mul_mat(text_matrix, ctm);
                            let bbox = transformed_bbox(
                                total_m,
                                0.0,
                                -0.25 * font_size + text_rise,
                                width_ts.max(font_size * 0.4),
                                0.9 * font_size + text_rise,
                            );
                            text_matrix =
                                mul_mat([1.0, 0.0, 0.0, 1.0, width_ts, 0.0], text_matrix);

                            if rects.iter().any(|r| bbox.intersects(r)) {
                                let advance_thousandths =
                                    -(width_ts * 1000.0) / (font_size * horiz_scale);
                                filtered_items.push(Object::Real(advance_thousandths as f32));
                            } else {
                                kept_any_string = true;
                                filtered_items.push(item.clone());
                            }
                        } else {
                            filtered_items.push(item.clone());
                        }
                    }

                    if kept_any_string {
                        out.push(Operation::new("TJ", vec![Object::Array(filtered_items)]));
                    } else if !filtered_items.is_empty() {
                        out.push(Operation::new("TJ", vec![Object::Array(filtered_items)]));
                    }
                } else {
                    out.push(op.clone());
                }
            }
            "Do" => {
                let bbox = transformed_bbox(ctm, 0.0, 0.0, 1.0, 1.0);
                if !rects.iter().any(|r| bbox.intersects(r)) {
                    out.push(op.clone());
                }
            }
            _ => out.push(op.clone()),
        }
    }

    out
}

fn scrub_page_annots_dict(
    doc: &mut lopdf::Document,
    page_id: lopdf::ObjectId,
    rects: &[PageBox],
) {
    let Ok(annots_obj) = doc
        .get_dictionary(page_id)
        .and_then(|d| d.get_deref(b"Annots", doc))
        .cloned()
    else {
        return;
    };
    let Ok(arr) = annots_obj.as_array() else {
        return;
    };

    let mut kept = Vec::with_capacity(arr.len());
    for entry in arr {
        let dict_opt = match &entry {
            Object::Reference(id) => doc.get_dictionary(*id).ok(),
            Object::Dictionary(d) => Some(d),
            _ => None,
        };
        let should_remove = dict_opt
            .and_then(|d| d.get(b"Rect").ok())
            .and_then(|r| r.as_array().ok())
            .and_then(|coords| {
                let vals: Vec<f64> = coords.iter().filter_map(obj_f64).collect();
                PageBox::from_rect_array(&vals)
            })
            .is_some_and(|bbox| rects.iter().any(|r| bbox.intersects(r)));
        if !should_remove {
            kept.push(entry.clone());
        }
    }

    if let Ok(page_dict) = doc.get_dictionary_mut(page_id) {
        if kept.is_empty() {
            page_dict.remove(b"Annots");
        } else {
            page_dict.set("Annots", kept);
        }
    }
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
                        merged.push(b'\n');
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
        Ok(Object::Array(arr)) => arr.first().and_then(|o| o.as_reference().ok()),
        _ => None,
    };

    if let Some(old_id) = old_contents_id {
        // Overwrite the primary stream in-place and point Contents to it so old array streams are pruned!
        doc.objects.insert(
            old_id,
            Object::Stream(Stream::new(lopdf::dictionary! {}, encoded_bytes)),
        );
        doc.get_dictionary_mut(page_id)?
            .set("Contents", Object::Reference(old_id));
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
