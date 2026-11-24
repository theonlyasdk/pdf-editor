use crate::document::{CoreError, DocumentState};
use crate::types::{AnnotationDto, AnnotationType, PageBox};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use image::GenericImageView;
use lopdf::content::{Content, Operation};
use lopdf::{dictionary, Object, ObjectId, Stream};

/// Decodes a base64 image string (supporting optional `data:image/...;base64,` prefix).
pub fn decode_image_base64(raw: &str) -> Result<Vec<u8>, CoreError> {
    let trimmed = raw.trim();
    let payload = if let Some(idx) = trimmed.find(";base64,") {
        &trimmed[idx + 8..]
    } else if let Some(idx) = trimmed.find("base64,") {
        &trimmed[idx + 7..]
    } else {
        trimmed
    };
    let compact: String = payload.chars().filter(|c| !c.is_whitespace()).collect();
    BASE64
        .decode(compact.as_bytes())
        .map_err(|e| CoreError::ValidationFailed(format!("Invalid base64 image data: {}", e)))
}

/// Applies in-memory annotations to the physical PDF document as standard PDF annotations.
pub fn commit_annotations_to_pdf(doc_state: &mut DocumentState) -> Result<(), CoreError> {
    for (&page_index, annots) in &doc_state.annotations {
        if annots.is_empty() {
            continue;
        }
        let page_id = doc_state.get_page_id(page_index)?;

        let mut annot_refs = Vec::new();

        for annot in annots {
            let annot_obj_id = create_pdf_annotation(&mut doc_state.doc, annot)?;
            annot_refs.push(Object::Reference(annot_obj_id));
        }

        let mut existing = doc_state
            .doc
            .get_dictionary(page_id)?
            .get_deref(b"Annots", &doc_state.doc)
            .ok()
            .and_then(|value| value.as_array().ok())
            .cloned()
            .unwrap_or_default();
        existing.extend(annot_refs);
        let page_dict = doc_state.doc.get_dictionary_mut(page_id)?;
        page_dict.set("Annots", existing);
    }
    Ok(())
}

fn hex_to_rgb(hex: &str) -> (f64, f64, f64) {
    let clean = hex.trim_start_matches('#');
    if clean.len() >= 6 {
        let r = u8::from_str_radix(&clean[0..2], 16).unwrap_or(0) as f64 / 255.0;
        let g = u8::from_str_radix(&clean[2..4], 16).unwrap_or(0) as f64 / 255.0;
        let b = u8::from_str_radix(&clean[4..6], 16).unwrap_or(0) as f64 / 255.0;
        (r, g, b)
    } else {
        (0.0, 0.0, 0.0)
    }
}

fn create_pdf_annotation(
    doc: &mut lopdf::Document,
    annot: &AnnotationDto,
) -> Result<lopdf::ObjectId, CoreError> {
    let (r, g, b) = hex_to_rgb(&annot.color);
    let rect_arr = vec![
        annot.rect.x.into(),
        annot.rect.y.into(),
        (annot.rect.x + annot.rect.width).into(),
        (annot.rect.y + annot.rect.height).into(),
    ];

    let subtype_str = match annot.annot_type {
        AnnotationType::Highlight => "Highlight",
        AnnotationType::Underline => "Underline",
        AnnotationType::StrikeOut => "StrikeOut",
        AnnotationType::Squiggly => "Squiggly",
        AnnotationType::Square | AnnotationType::Cover => "Square",
        AnnotationType::Circle => "Circle",
        AnnotationType::Line | AnnotationType::Arrow => "Line",
        AnnotationType::Ink => "Ink",
        AnnotationType::FreeText => "FreeText",
        AnnotationType::StickyNote => "Text",
        AnnotationType::Stamp | AnnotationType::Image => "Stamp",
    };

    let flags = if annot.locked { 4 | 128 } else { 4 };

    let mut dict = dictionary! {
        "Type" => "Annot",
        "Subtype" => subtype_str,
        "Rect" => rect_arr,
        "NM" => Object::string_literal(annot.id.as_str()),
        "F" => flags,
        "C" => vec![r.into(), g.into(), b.into()],
        "CA" => Object::Real(annot.opacity as f32),
        "ca" => Object::Real(annot.opacity as f32),
    };

    if let Some(ref text) = annot.text {
        dict.set("Contents", Object::string_literal(text.as_str()));
    }
    if let Some(ref author) = annot.author {
        dict.set("T", Object::string_literal(author.as_str()));
    }
    if let Some(ref modified) = annot.modified_date {
        dict.set("M", Object::string_literal(modified.as_str()));
    }

    let points = |line: &[crate::types::Point2D]| {
        line.iter()
            .flat_map(|point| [Object::from(point.x), Object::from(point.y)])
            .collect::<Vec<_>>()
    };
    match annot.annot_type {
        AnnotationType::Ink => {
            if let Some(lines) = &annot.points {
                dict.set(
                    "InkList",
                    lines
                        .iter()
                        .map(|line| Object::Array(points(line)))
                        .collect::<Vec<_>>(),
                );
            }
        }
        AnnotationType::Line | AnnotationType::Arrow => {
            if let Some(line) = annot.points.as_ref().and_then(|lines| lines.first()) {
                dict.set("L", points(line));
            }
            if annot.annot_type == AnnotationType::Arrow {
                dict.set(
                    "LE",
                    vec![
                        Object::Name(b"None".to_vec()),
                        Object::Name(b"OpenArrow".to_vec()),
                    ],
                );
            }
        }
        AnnotationType::Highlight
        | AnnotationType::Underline
        | AnnotationType::StrikeOut
        | AnnotationType::Squiggly => {
            let PageBox {
                x,
                y,
                width,
                height,
            } = annot.rect;
            dict.set(
                "QuadPoints",
                vec![
                    x.into(),
                    (y + height).into(),
                    (x + width).into(),
                    (y + height).into(),
                    x.into(),
                    y.into(),
                    (x + width).into(),
                    y.into(),
                ],
            );
        }
        AnnotationType::StickyNote => {
            dict.set("Name", Object::Name(b"Note".to_vec()));
            return Ok(doc.add_object(dict));
        }
        AnnotationType::Image => {
            if let Some(ref b64) = annot.image_base64 {
                let ap_stream_id = create_image_appearance_stream(doc, annot, b64)?;
                dict.set("AP", dictionary! { "N" => Object::Reference(ap_stream_id) });
                return Ok(doc.add_object(dict));
            }
        }
        _ => {}
    }

    // Generate Appearance Stream (/AP << /N stream >>)
    let ap_stream_bytes = generate_appearance_stream(annot, r, g, b);
    let ap_stream_id = doc.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Form",
            "BBox" => vec![0.into(), 0.into(), annot.rect.width.into(), annot.rect.height.into()],
            "Resources" => dictionary! {
                "Font" => dictionary! { "F0" => dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => annot.font_family.as_deref().unwrap_or("Helvetica"), "Encoding" => "WinAnsiEncoding" } },
                "ExtGState" => dictionary! { "Opacity" => dictionary! { "Type" => "ExtGState", "CA" => Object::Real(annot.opacity as f32), "ca" => Object::Real(annot.opacity as f32) } }
            },
        },
        ap_stream_bytes,
    ));

    dict.set("AP", dictionary! { "N" => Object::Reference(ap_stream_id) });

    let annot_id = doc.add_object(dict);
    Ok(annot_id)
}

fn create_image_appearance_stream(
    doc: &mut lopdf::Document,
    annot: &AnnotationDto,
    image_b64: &str,
) -> Result<ObjectId, CoreError> {
    let raw = decode_image_base64(image_b64)?;
    let dyn_img = image::load_from_memory(&raw)
        .map_err(|e| CoreError::ValidationFailed(format!("Failed to decode image: {}", e)))?;
    let (img_w, img_h) = dyn_img.dimensions();
    let rgba = dyn_img.to_rgba8();

    let mut rgb_bytes = Vec::with_capacity((img_w * img_h * 3) as usize);
    let mut alpha_bytes = Vec::with_capacity((img_w * img_h) as usize);
    let mut has_transparency = false;

    for px in rgba.pixels() {
        rgb_bytes.push(px[0]);
        rgb_bytes.push(px[1]);
        rgb_bytes.push(px[2]);
        alpha_bytes.push(px[3]);
        if px[3] < 255 {
            has_transparency = true;
        }
    }

    let mut image_dict = dictionary! {
        "Type" => "XObject",
        "Subtype" => "Image",
        "Width" => img_w as i64,
        "Height" => img_h as i64,
        "ColorSpace" => "DeviceRGB",
        "BitsPerComponent" => 8,
    };

    if has_transparency {
        let mut smask_stream = Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Image",
                "Width" => img_w as i64,
                "Height" => img_h as i64,
                "ColorSpace" => "DeviceGray",
                "BitsPerComponent" => 8,
            },
            alpha_bytes,
        );
        let _ = smask_stream.compress();
        let smask_id = doc.add_object(smask_stream);
        image_dict.set("SMask", Object::Reference(smask_id));
    }

    let mut image_stream = Stream::new(image_dict, rgb_bytes);
    let _ = image_stream.compress();
    let image_id = doc.add_object(image_stream);

    let w = annot.rect.width.max(1.0);
    let h = annot.rect.height.max(1.0);
    let ops = vec![
        Operation::new("q", vec![]),
        Operation::new("gs", vec!["Opacity".into()]),
        Operation::new(
            "cm",
            vec![w.into(), 0.into(), 0.into(), h.into(), 0.into(), 0.into()],
        ),
        Operation::new("Do", vec!["Im0".into()]),
        Operation::new("Q", vec![]),
    ];
    let ap_bytes = Content { operations: ops }.encode().unwrap_or_default();

    let ap_stream_id = doc.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Form",
            "BBox" => vec![0.into(), 0.into(), w.into(), h.into()],
            "Resources" => dictionary! {
                "XObject" => dictionary! { "Im0" => Object::Reference(image_id) },
                "ExtGState" => dictionary! { "Opacity" => dictionary! {
                    "Type" => "ExtGState",
                    "CA" => Object::Real(annot.opacity as f32),
                    "ca" => Object::Real(annot.opacity as f32),
                }}
            },
        },
        ap_bytes,
    ));
    Ok(ap_stream_id)
}

fn generate_appearance_stream(annot: &AnnotationDto, r: f64, g: f64, b: f64) -> Vec<u8> {
    let w = annot.rect.width;
    let h = annot.rect.height;
    let stroke = annot.stroke_width.max(1.0);

    let mut ops = vec![
        // Save graphics state
        Operation::new("q", vec![]),
        // Color and line width
        Operation::new("RG", vec![r.into(), g.into(), b.into()]),
        Operation::new("rg", vec![r.into(), g.into(), b.into()]),
        Operation::new("w", vec![stroke.into()]),
        Operation::new("J", vec![1.into()]),
        Operation::new("j", vec![1.into()]),
        Operation::new("gs", vec!["Opacity".into()]),
    ];

    match annot.annot_type {
        AnnotationType::Square | AnnotationType::Cover => {
            if let Some(ref fill_hex) = annot.fill_color {
                let (fr, fg, fb) = hex_to_rgb(fill_hex);
                ops.push(Operation::new("rg", vec![fr.into(), fg.into(), fb.into()]));
                ops.push(Operation::new(
                    "re",
                    vec![0.into(), 0.into(), w.into(), h.into()],
                ));
                ops.push(Operation::new("B", vec![])); // Fill and stroke
            } else {
                ops.push(Operation::new(
                    "re",
                    vec![0.into(), 0.into(), w.into(), h.into()],
                ));
                ops.push(Operation::new("S", vec![]));
            }
        }
        AnnotationType::Highlight => {
            ops.push(Operation::new(
                "re",
                vec![0.into(), 0.into(), w.into(), h.into()],
            ));
            ops.push(Operation::new("f", vec![]));
        }
        AnnotationType::Circle => {
            let cx = w / 2.0;
            let cy = h / 2.0;
            let rx = (cx - stroke / 2.0).max(0.0);
            let ry = (cy - stroke / 2.0).max(0.0);
            let kx = rx * 0.552_284_75;
            let ky = ry * 0.552_284_75;
            ops.push(Operation::new("m", vec![(cx + rx).into(), cy.into()]));
            for curve in [
                [cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry],
                [cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy],
                [cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry],
                [cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy],
            ] {
                ops.push(Operation::new(
                    "c",
                    curve.into_iter().map(Object::from).collect(),
                ));
            }
            if let Some(fill) = &annot.fill_color {
                let (r, g, b) = hex_to_rgb(fill);
                ops.push(Operation::new("rg", vec![r.into(), g.into(), b.into()]));
                ops.push(Operation::new("B", vec![]));
            } else {
                ops.push(Operation::new("S", vec![]));
            }
        }
        AnnotationType::Underline | AnnotationType::StrikeOut | AnnotationType::Squiggly => {
            let y = if annot.annot_type == AnnotationType::StrikeOut {
                h / 2.0
            } else {
                stroke / 2.0
            };
            ops.push(Operation::new("m", vec![0.into(), y.into()]));
            if annot.annot_type == AnnotationType::Squiggly {
                let steps = (w / 3.0).ceil().clamp(1.0, 500.0) as usize;
                for step in 1..=steps {
                    let y = if step % 2 == 0 { y } else { (y + 2.0).min(h) };
                    ops.push(Operation::new(
                        "l",
                        vec![(w * step as f64 / steps as f64).into(), y.into()],
                    ));
                }
            } else {
                ops.push(Operation::new("l", vec![w.into(), y.into()]));
            }
            ops.push(Operation::new("S", vec![]));
        }
        AnnotationType::Line | AnnotationType::Arrow => {
            let line = annot.points.as_ref().and_then(|lines| lines.first());
            let first = line
                .and_then(|points| points.first())
                .map_or((0.0, 0.0), |p| (p.x - annot.rect.x, p.y - annot.rect.y));
            let end = line
                .and_then(|points| points.last())
                .map_or((w, h), |p| (p.x - annot.rect.x, p.y - annot.rect.y));
            ops.push(Operation::new("m", vec![first.0.into(), first.1.into()]));
            ops.push(Operation::new("l", vec![end.0.into(), end.1.into()]));
            if annot.annot_type == AnnotationType::Arrow {
                let angle = (end.1 - first.1).atan2(end.0 - first.0);
                let length = 12.0_f64.min((end.0 - first.0).hypot(end.1 - first.1) / 2.0);
                for offset in [-0.5, 0.5] {
                    ops.push(Operation::new("m", vec![end.0.into(), end.1.into()]));
                    ops.push(Operation::new(
                        "l",
                        vec![
                            (end.0 - length * (angle + offset).cos()).into(),
                            (end.1 - length * (angle + offset).sin()).into(),
                        ],
                    ));
                }
            }
            ops.push(Operation::new("S", vec![]));
        }
        AnnotationType::Ink => {
            if let Some(ref point_lists) = annot.points {
                for line in point_lists {
                    if let Some(first) = line.first() {
                        let rel_x = first.x - annot.rect.x;
                        let rel_y = first.y - annot.rect.y;
                        ops.push(Operation::new("m", vec![rel_x.into(), rel_y.into()]));
                        for pt in line.iter().skip(1) {
                            let rx = pt.x - annot.rect.x;
                            let ry = pt.y - annot.rect.y;
                            ops.push(Operation::new("l", vec![rx.into(), ry.into()]));
                        }
                        ops.push(Operation::new("S", vec![]));
                    }
                }
            }
        }
        AnnotationType::FreeText | AnnotationType::Stamp => {
            let size = annot.font_size.unwrap_or(12.0);
            if annot.annot_type == AnnotationType::Stamp {
                ops.push(Operation::new(
                    "re",
                    vec![
                        stroke.into(),
                        stroke.into(),
                        (w - stroke * 2.0).max(0.0).into(),
                        (h - stroke * 2.0).max(0.0).into(),
                    ],
                ));
                ops.push(Operation::new("S", vec![]));
            }
            if let Some(ref text) = annot.text {
                ops.push(Operation::new("BT", vec![]));
                ops.push(Operation::new("Tf", vec!["F0".into(), size.into()]));
                ops.push(Operation::new(
                    "Td",
                    vec![4.into(), (h - size - 4.0).max(4.0).into()],
                ));
                for (index, line) in text.lines().enumerate() {
                    if index > 0 {
                        ops.push(Operation::new("Td", vec![0.into(), (-size * 1.2).into()]));
                    }
                    ops.push(Operation::new("Tj", vec![Object::string_literal(line)]));
                }
                ops.push(Operation::new("ET", vec![]));
            }
        }
        _ => {
            ops.push(Operation::new(
                "re",
                vec![0.into(), 0.into(), w.into(), h.into()],
            ));
            ops.push(Operation::new("S", vec![]));
        }
    }

    // Restore graphics state
    ops.push(Operation::new("Q", vec![]));

    let content = Content { operations: ops };
    content.encode().unwrap_or_default()
}

/// Flattens all annotations permanently into page content streams.
pub fn flatten_annotations(doc_state: &mut DocumentState) -> Result<(), CoreError> {
    commit_annotations_to_pdf(doc_state)?;

    for page_index in 0..doc_state.page_count() {
        let page_id = doc_state.get_page_id(page_index)?;
        let page_dict = doc_state.doc.get_dictionary_mut(page_id)?;

        // Remove /Annots
        page_dict.remove(b"Annots");
    }
    doc_state.annotations.clear();
    Ok(())
}
