use crate::document::{CoreError, DocumentState};
use crate::types::{AnnotationDto, AnnotationType};
use lopdf::content::{Content, Operation};
use lopdf::{dictionary, Object, Stream};

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

        let page_dict = doc_state.doc.get_dictionary_mut(page_id)?;
        if let Ok(existing_annots) = page_dict.get_mut(b"Annots") {
            if let Ok(arr) = existing_annots.as_array_mut() {
                arr.extend(annot_refs);
            }
        } else {
            page_dict.set("Annots", annot_refs);
        }
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
        AnnotationType::Stamp => "Stamp",
        AnnotationType::Image => "Square",
    };

    let mut dict = dictionary! {
        "Type" => "Annot",
        "Subtype" => subtype_str,
        "Rect" => rect_arr.clone(),
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

    // Generate Appearance Stream (/AP << /N stream >>)
    let ap_stream_bytes = generate_appearance_stream(annot, r, g, b);
    let ap_stream_id = doc.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Form",
            "BBox" => vec![0.into(), 0.into(), annot.rect.width.into(), annot.rect.height.into()],
        },
        ap_stream_bytes,
    ));

    dict.set("AP", dictionary! { "N" => Object::Reference(ap_stream_id) });

    let annot_id = doc.add_object(dict);
    Ok(annot_id)
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
        AnnotationType::Line | AnnotationType::Arrow => {
            ops.push(Operation::new("m", vec![0.into(), 0.into()]));
            ops.push(Operation::new("l", vec![w.into(), h.into()]));
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
        AnnotationType::FreeText => {
            if let Some(ref text) = annot.text {
                ops.push(Operation::new("BT", vec![]));
                ops.push(Operation::new("Tf", vec!["Helvetica".into(), 12.into()]));
                ops.push(Operation::new(
                    "Td",
                    vec![4.into(), (h - 14.0).max(4.0).into()],
                ));
                ops.push(Operation::new(
                    "Tj",
                    vec![Object::string_literal(text.as_str())],
                ));
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
