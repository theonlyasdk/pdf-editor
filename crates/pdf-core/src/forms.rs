use crate::document::{CoreError, DocumentState};
use crate::outline::{decode_pdf_string, encode_pdf_string};
use crate::types::{FormFieldDto, FormFieldType, PageBox};
use lopdf::content::{Content, Operation};
use lopdf::{dictionary, Dictionary, Document, Object, ObjectId, Stream};

fn obj_f64(obj: &Object) -> Option<f64> {
    match obj {
        Object::Real(v) => Some(f64::from(*v)),
        Object::Integer(v) => Some(*v as f64),
        _ => None,
    }
}

fn parse_rect(dict: &Dictionary, doc: &Document) -> Option<PageBox> {
    let arr = dict.get_deref(b"Rect", doc).ok()?.as_array().ok()?;
    let nums: Vec<f64> = arr.iter().filter_map(obj_f64).collect();
    PageBox::from_rect_array(&nums).filter(|r| r.width > 0.0 && r.height > 0.0)
}

fn resolve_inherited<'a>(
    doc: &'a Document,
    mut dict: &'a Dictionary,
    key: &[u8],
) -> Option<&'a Object> {
    for _ in 0..16 {
        if let Ok(val) = dict.get_deref(key, doc) {
            return Some(val);
        }
        let parent_id = dict.get(b"Parent").ok()?.as_reference().ok()?;
        dict = doc.get_dictionary(parent_id).ok()?;
    }
    None
}

fn resolve_qualified_name<'a>(doc: &'a Document, mut dict: &'a Dictionary, fallback_id: ObjectId) -> String {
    let mut parts = Vec::new();
    for _ in 0..16 {
        if let Ok(t_obj) = dict.get_deref(b"T", doc) {
            let s = match t_obj {
                Object::String(bytes, _) => decode_pdf_string(bytes),
                _ => t_obj.as_str().map(decode_pdf_string).unwrap_or_default(),
            };
            if !s.is_empty() {
                parts.push(s);
            }
        }
        let Ok(parent_id) = dict.get(b"Parent").and_then(|o| o.as_reference()) else {
            break;
        };
        let Ok(parent_dict) = doc.get_dictionary(parent_id) else {
            break;
        };
        dict = parent_dict;
    }
    if parts.is_empty() {
        format!("field_{}_{}", fallback_id.0, fallback_id.1)
    } else {
        parts.reverse();
        parts.join(".")
    }
}

fn parse_da_font_size(da: &str) -> Option<f64> {
    let tokens: Vec<&str> = da.split_whitespace().collect();
    for win in tokens.windows(2) {
        if win[1] == "Tf" {
            if let Ok(sz) = win[0].parse::<f64>() {
                if sz > 0.0 {
                    return Some(sz);
                }
            }
        }
    }
    None
}

fn decode_obj_text(obj: &Object) -> String {
    match obj {
        Object::String(bytes, _) => decode_pdf_string(bytes),
        Object::Name(bytes) => String::from_utf8_lossy(bytes).into_owned(),
        _ => obj.as_str().map(decode_pdf_string).unwrap_or_default(),
    }
}

fn parse_options(doc: &Document, dict: &Dictionary) -> Vec<String> {
    let Some(opt_obj) = resolve_inherited(doc, dict, b"Opt") else {
        return Vec::new();
    };
    let Ok(arr) = opt_obj.as_array() else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|item| match item {
            Object::Array(pair) => pair.get(1).or_else(|| pair.first()).map(decode_obj_text),
            other => Some(decode_obj_text(other)),
        })
        .collect()
}

fn extract_export_value(doc: &Document, widget_dict: &Dictionary) -> Option<String> {
    let ap_dict = widget_dict.get_deref(b"AP", doc).ok()?.as_dict().ok()?;
    let n_dict = ap_dict.get_deref(b"N", doc).ok()?.as_dict().ok()?;
    for (key, _) in n_dict.iter() {
        if key.as_slice() != b"Off" {
            return Some(String::from_utf8_lossy(key).into_owned());
        }
    }
    None
}

pub fn extract_form_fields(doc_state: &DocumentState) -> Result<Vec<FormFieldDto>, CoreError> {
    let doc = &doc_state.doc;
    let mut fields = Vec::new();

    for page_index in 0..doc_state.page_count() {
        let page_id = doc_state.get_page_id(page_index)?;
        let Ok(page_dict) = doc.get_dictionary(page_id) else {
            continue;
        };
        let Ok(annots_obj) = page_dict.get_deref(b"Annots", doc) else {
            continue;
        };
        let Ok(annots) = annots_obj.as_array() else {
            continue;
        };

        for entry in annots {
            let Ok(annot_id) = entry.as_reference() else {
                continue;
            };
            let Ok(widget_dict) = doc.get_dictionary(annot_id) else {
                continue;
            };
            let is_widget = widget_dict
                .get_deref(b"Subtype", doc)
                .ok()
                .and_then(|s| s.as_name().ok())
                .is_some_and(|n| n == b"Widget");
            if !is_widget {
                continue;
            }

            let Some(rect) = parse_rect(widget_dict, doc) else {
                continue;
            };
            let Some(ft) = resolve_inherited(doc, widget_dict, b"FT")
                .and_then(|o| o.as_name().ok())
            else {
                continue;
            };

            let ff = resolve_inherited(doc, widget_dict, b"Ff")
                .and_then(|o| o.as_i64().ok())
                .unwrap_or(0);

            let field_type = match ft {
                b"Tx" => FormFieldType::Text,
                b"Ch" => {
                    if (ff & (1 << 17)) != 0 {
                        FormFieldType::Dropdown
                    } else {
                        FormFieldType::Listbox
                    }
                }
                b"Btn" => {
                    if (ff & (1 << 16)) != 0 {
                        // Pushbutton — not a fillable value field
                        continue;
                    } else if (ff & (1 << 15)) != 0 {
                        FormFieldType::Radio
                    } else {
                        FormFieldType::Checkbox
                    }
                }
                _ => continue,
            };

            let read_only = (ff & 1) != 0;
            let multiline = (ff & (1 << 12)) != 0;
            let max_len = resolve_inherited(doc, widget_dict, b"MaxLen")
                .and_then(|o| o.as_i64().ok())
                .and_then(|v| (v > 0).then_some(v as usize));
            let font_size = resolve_inherited(doc, widget_dict, b"DA")
                .map(decode_obj_text)
                .and_then(|da| parse_da_font_size(&da));

            let name = resolve_qualified_name(doc, widget_dict, annot_id);
            let options = if matches!(field_type, FormFieldType::Dropdown | FormFieldType::Listbox) {
                parse_options(doc, widget_dict)
            } else {
                Vec::new()
            };

            let export_value = if matches!(field_type, FormFieldType::Checkbox | FormFieldType::Radio) {
                Some(extract_export_value(doc, widget_dict).unwrap_or_else(|| "Yes".to_string()))
            } else {
                None
            };

            let value = match field_type {
                FormFieldType::Checkbox => {
                    let on_val = widget_dict
                        .get_deref(b"AS", doc)
                        .ok()
                        .or_else(|| resolve_inherited(doc, widget_dict, b"V"))
                        .map(decode_obj_text)
                        .unwrap_or_default();
                    let checked = !on_val.is_empty() && on_val != "Off";
                    if checked { "true".to_string() } else { "false".to_string() }
                }
                FormFieldType::Radio => {
                    resolve_inherited(doc, widget_dict, b"V")
                        .map(decode_obj_text)
                        .filter(|v| !v.is_empty() && v != "Off")
                        .unwrap_or_else(|| {
                            widget_dict
                                .get_deref(b"AS", doc)
                                .ok()
                                .map(decode_obj_text)
                                .filter(|v| !v.is_empty() && v != "Off")
                                .unwrap_or_default()
                        })
                }
                FormFieldType::Text | FormFieldType::Dropdown | FormFieldType::Listbox => {
                    resolve_inherited(doc, widget_dict, b"V")
                        .map(decode_obj_text)
                        .unwrap_or_default()
                }
            };

            fields.push(FormFieldDto {
                id: format!("{}_{}", annot_id.0, annot_id.1),
                name,
                field_type,
                page_index,
                rect,
                value,
                export_value,
                options,
                multiline,
                read_only,
                max_len,
                font_size,
            });
        }
    }

    Ok(fields)
}

fn parse_field_object_id(field_id: &str) -> Result<ObjectId, CoreError> {
    let mut parts = field_id.split('_');
    let obj_num = parts
        .next()
        .and_then(|s| s.parse::<u32>().ok())
        .ok_or_else(|| CoreError::InvalidOperation(format!("Invalid form field id: {}", field_id)))?;
    let gen_num = parts
        .next()
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or_else(|| CoreError::InvalidOperation(format!("Invalid form field id: {}", field_id)))?;
    Ok((obj_num, gen_num))
}

fn find_widget_page(doc_state: &DocumentState, widget_id: ObjectId) -> Result<usize, CoreError> {
    for page_index in 0..doc_state.page_count() {
        let page_id = doc_state.get_page_id(page_index)?;
        if let Ok(page_dict) = doc_state.doc.get_dictionary(page_id) {
            if let Ok(annots) = page_dict.get_deref(b"Annots", &doc_state.doc).and_then(|o| o.as_array()) {
                if annots.iter().any(|o| o.as_reference().ok() == Some(widget_id)) {
                    return Ok(page_index);
                }
            }
        }
    }
    Err(CoreError::InvalidOperation(format!(
        "Form widget {:?} not found on any page",
        widget_id
    )))
}

fn build_text_appearance_stream(rect: PageBox, text: &str, font_size: f64) -> Stream {
    let fsize = font_size.clamp(6.0, (rect.height * 0.85).max(8.0));
    let y_off = ((rect.height - fsize) * 0.5).max(2.0);
    let ops = vec![
        Operation::new("q", vec![]),
        Operation::new("BT", vec![]),
        Operation::new(
            "Tf",
            vec![Object::Name(b"Helv".to_vec()), (fsize as f32).into()],
        ),
        Operation::new("rg", vec![0.0.into(), 0.0.into(), 0.0.into()]),
        Operation::new("Td", vec![2.0.into(), (y_off as f32).into()]),
        Operation::new("Tj", vec![encode_pdf_string(text)]),
        Operation::new("ET", vec![]),
        Operation::new("Q", vec![]),
    ];
    let bytes = Content { operations: ops }.encode().unwrap_or_default();
    let resources = dictionary! {
        "Font" => dictionary! {
            "Helv" => dictionary! {
                "Type" => "Font",
                "Subtype" => "Type1",
                "BaseFont" => "Helvetica",
            }
        }
    };
    Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Form",
            "BBox" => vec![0.0.into(), 0.0.into(), (rect.width as f32).into(), (rect.height as f32).into()],
            "Resources" => resources,
        },
        bytes,
    )
}

fn build_check_appearance_stream(rect: PageBox, checked: bool, is_radio: bool) -> Stream {
    let mut ops = vec![Operation::new("q", vec![])];
    if checked {
        let w = rect.width;
        let h = rect.height;
        if is_radio {
            let cx = w * 0.5;
            let cy = h * 0.5;
            let r = w.min(h) * 0.25;
            ops.push(Operation::new("rg", vec![0.1.into(), 0.1.into(), 0.1.into()]));
            ops.push(Operation::new(
                "re",
                vec![
                    ((cx - r) as f32).into(),
                    ((cy - r) as f32).into(),
                    ((2.0 * r) as f32).into(),
                    ((2.0 * r) as f32).into(),
                ],
            ));
            ops.push(Operation::new("f", vec![]));
        } else {
            ops.push(Operation::new("RG", vec![0.1.into(), 0.1.into(), 0.1.into()]));
            ops.push(Operation::new("w", vec![(w.min(h) * 0.12).max(1.2).into()]));
            ops.push(Operation::new("m", vec![(w * 0.22).into(), (h * 0.50).into()]));
            ops.push(Operation::new("l", vec![(w * 0.42).into(), (h * 0.28).into()]));
            ops.push(Operation::new("l", vec![(w * 0.78).into(), (h * 0.72).into()]));
            ops.push(Operation::new("S", vec![]));
        }
    }
    ops.push(Operation::new("Q", vec![]));
    let bytes = Content { operations: ops }.encode().unwrap_or_default();
    Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Form",
            "BBox" => vec![0.0.into(), 0.0.into(), (rect.width as f32).into(), (rect.height as f32).into()],
        },
        bytes,
    )
}

pub fn set_form_field_value(
    doc_state: &mut DocumentState,
    field_id: &str,
    value: &str,
) -> Result<usize, CoreError> {
    let widget_id = parse_field_object_id(field_id)?;
    let page_index = find_widget_page(doc_state, widget_id)?;

    let (ft_bytes, ff, rect, parent_id, export_val, da_font_size) = {
        let widget_dict = doc_state.doc.get_dictionary(widget_id)?;
        let ft = resolve_inherited(&doc_state.doc, widget_dict, b"FT")
            .and_then(|o| o.as_name().ok())
            .ok_or_else(|| CoreError::InvalidOperation("Widget missing /FT".to_string()))?
            .to_vec();
        let ff = resolve_inherited(&doc_state.doc, widget_dict, b"Ff")
            .and_then(|o| o.as_i64().ok())
            .unwrap_or(0);
        let rect = parse_rect(widget_dict, &doc_state.doc)
            .unwrap_or(PageBox::new(0.0, 0.0, 100.0, 20.0));
        let parent_id = widget_dict.get(b"Parent").ok().and_then(|o| o.as_reference().ok());
        let export_val = extract_export_value(&doc_state.doc, widget_dict)
            .unwrap_or_else(|| "Yes".to_string());
        let da_font_size = resolve_inherited(&doc_state.doc, widget_dict, b"DA")
            .map(decode_obj_text)
            .and_then(|da| parse_da_font_size(&da))
            .unwrap_or(11.0);
        (ft, ff, rect, parent_id, export_val, da_font_size)
    };

    match ft_bytes.as_slice() {
        b"Tx" | b"Ch" => {
            let encoded = encode_pdf_string(value);
            if let Some(pid) = parent_id {
                if let Ok(pdict) = doc_state.doc.get_dictionary_mut(pid) {
                    pdict.set("V", encoded.clone());
                }
            }
            let ap_stream = build_text_appearance_stream(rect, value, da_font_size);
            let ap_id = doc_state.doc.add_object(ap_stream);
            let widget_dict = doc_state.doc.get_dictionary_mut(widget_id)?;
            widget_dict.set("V", encoded);
            widget_dict.set("AP", dictionary! { "N" => ap_id });
        }
        b"Btn" => {
            let is_radio = (ff & (1 << 15)) != 0;
            if is_radio {
                let target_name = if value.is_empty() { "Off" } else { value };
                let name_obj = Object::Name(target_name.as_bytes().to_vec());
                if let Some(pid) = parent_id {
                    let kid_ids: Vec<ObjectId> = doc_state
                        .doc
                        .get_dictionary(pid)
                        .ok()
                        .and_then(|d| d.get_deref(b"Kids", &doc_state.doc).ok())
                        .and_then(|o| o.as_array().ok())
                        .map(|arr| arr.iter().filter_map(|o| o.as_reference().ok()).collect())
                        .unwrap_or_default();

                    if let Ok(pdict) = doc_state.doc.get_dictionary_mut(pid) {
                        pdict.set("V", name_obj.clone());
                    }
                    for kid_id in kid_ids {
                        let kid_export = doc_state
                            .doc
                            .get_dictionary(kid_id)
                            .ok()
                            .and_then(|d| extract_export_value(&doc_state.doc, d))
                            .unwrap_or_else(|| "Yes".to_string());
                        let is_selected = kid_id == widget_id || kid_export == target_name;
                        let as_val = if is_selected && target_name != "Off" {
                            Object::Name(kid_export.into_bytes())
                        } else {
                            Object::Name(b"Off".to_vec())
                        };
                        if let Ok(kdict) = doc_state.doc.get_dictionary_mut(kid_id) {
                            kdict.set("AS", as_val);
                        }
                    }
                } else {
                    let on_stream = build_check_appearance_stream(rect, true, true);
                    let off_stream = build_check_appearance_stream(rect, false, true);
                    let on_id = doc_state.doc.add_object(on_stream);
                    let off_id = doc_state.doc.add_object(off_stream);
                    let widget_dict = doc_state.doc.get_dictionary_mut(widget_id)?;
                    widget_dict.set("V", name_obj.clone());
                    widget_dict.set("AS", name_obj);
                    widget_dict.set(
                        "AP",
                        dictionary! {
                            "N" => dictionary! {
                                export_val.as_str() => on_id,
                                "Off" => off_id,
                            }
                        },
                    );
                }
            } else {
                let checked = value == "true" || value == "1" || value == export_val;
                let state_name = if checked {
                    Object::Name(export_val.clone().into_bytes())
                } else {
                    Object::Name(b"Off".to_vec())
                };
                if let Some(pid) = parent_id {
                    if let Ok(pdict) = doc_state.doc.get_dictionary_mut(pid) {
                        pdict.set("V", state_name.clone());
                    }
                }
                let on_stream = build_check_appearance_stream(rect, true, false);
                let off_stream = build_check_appearance_stream(rect, false, false);
                let on_id = doc_state.doc.add_object(on_stream);
                let off_id = doc_state.doc.add_object(off_stream);
                let widget_dict = doc_state.doc.get_dictionary_mut(widget_id)?;
                widget_dict.set("V", state_name.clone());
                widget_dict.set("AS", state_name);
                widget_dict.set(
                    "AP",
                    dictionary! {
                        "N" => dictionary! {
                            export_val.as_str() => on_id,
                            "Off" => off_id,
                        }
                    },
                );
            }
        }
        _ => {}
    }

    Ok(page_index)
}

pub fn flatten_form_fields(doc_state: &mut DocumentState) -> Result<Vec<usize>, CoreError> {
    let fields = extract_form_fields(doc_state)?;
    let mut by_page: std::collections::HashMap<usize, Vec<FormFieldDto>> =
        std::collections::HashMap::new();
    for f in fields {
        by_page.entry(f.page_index).or_default().push(f);
    }

    let mut affected = Vec::new();
    for (page_index, page_fields) in &by_page {
        let page_id = doc_state.get_page_id(*page_index)?;
        let mut ops = Vec::new();

        for field in page_fields {
            let r = field.rect;
            match field.field_type {
                FormFieldType::Text | FormFieldType::Dropdown | FormFieldType::Listbox => {
                    if !field.value.is_empty() {
                        let fsize = field
                            .font_size
                            .unwrap_or(11.0)
                            .clamp(6.0, (r.height * 0.85).max(8.0));
                        let y_pos = r.y + ((r.height - fsize) * 0.5).max(2.0);
                        ops.push(Operation::new("q", vec![]));
                        ops.push(Operation::new("BT", vec![]));
                        ops.push(Operation::new(
                            "Tf",
                            vec![Object::Name(b"Helvetica".to_vec()), (fsize as f32).into()],
                        ));
                        ops.push(Operation::new("rg", vec![0.0.into(), 0.0.into(), 0.0.into()]));
                        ops.push(Operation::new(
                            "Td",
                            vec![((r.x + 2.0) as f32).into(), (y_pos as f32).into()],
                        ));
                        ops.push(Operation::new("Tj", vec![encode_pdf_string(&field.value)]));
                        ops.push(Operation::new("ET", vec![]));
                        ops.push(Operation::new("Q", vec![]));
                    }
                }
                FormFieldType::Checkbox => {
                    if field.value == "true" {
                        ops.push(Operation::new("q", vec![]));
                        ops.push(Operation::new("RG", vec![0.1.into(), 0.1.into(), 0.1.into()]));
                        ops.push(Operation::new("w", vec![(r.width.min(r.height) * 0.12).max(1.2).into()]));
                        ops.push(Operation::new("m", vec![(r.x + r.width * 0.22).into(), (r.y + r.height * 0.50).into()]));
                        ops.push(Operation::new("l", vec![(r.x + r.width * 0.42).into(), (r.y + r.height * 0.28).into()]));
                        ops.push(Operation::new("l", vec![(r.x + r.width * 0.78).into(), (r.y + r.height * 0.72).into()]));
                        ops.push(Operation::new("S", vec![]));
                        ops.push(Operation::new("Q", vec![]));
                    }
                }
                FormFieldType::Radio => {
                    if field.export_value.as_deref() == Some(field.value.as_str()) && !field.value.is_empty() {
                        let cx = r.x + r.width * 0.5;
                        let cy = r.y + r.height * 0.5;
                        let rad = r.width.min(r.height) * 0.25;
                        ops.push(Operation::new("q", vec![]));
                        ops.push(Operation::new("rg", vec![0.1.into(), 0.1.into(), 0.1.into()]));
                        ops.push(Operation::new(
                            "re",
                            vec![
                                ((cx - rad) as f32).into(),
                                ((cy - rad) as f32).into(),
                                ((2.0 * rad) as f32).into(),
                                ((2.0 * rad) as f32).into(),
                            ],
                        ));
                        ops.push(Operation::new("f", vec![]));
                        ops.push(Operation::new("Q", vec![]));
                    }
                }
            }
        }

        if !ops.is_empty() {
            append_ops_to_page(&mut doc_state.doc, page_id, ops)?;
        }

        // Remove Widget annotations from page /Annots
        if let Ok(annots_obj) = doc_state
            .doc
            .get_dictionary(page_id)
            .and_then(|d| d.get_deref(b"Annots", &doc_state.doc))
            .cloned()
        {
            if let Ok(arr) = annots_obj.as_array() {
                let mut kept = Vec::new();
                for entry in arr {
                    let is_widget = entry
                        .as_reference()
                        .ok()
                        .and_then(|id| doc_state.doc.get_dictionary(id).ok())
                        .and_then(|d| d.get_deref(b"Subtype", &doc_state.doc).ok())
                        .and_then(|s| s.as_name().ok())
                        .is_some_and(|n| n == b"Widget");
                    if !is_widget {
                        kept.push(entry.clone());
                    }
                }
                if let Ok(page_dict) = doc_state.doc.get_dictionary_mut(page_id) {
                    if kept.is_empty() {
                        page_dict.remove(b"Annots");
                    } else {
                        page_dict.set("Annots", kept);
                    }
                }
            }
        }
        affected.push(*page_index);
    }

    if let Ok(root_id) = doc_state.doc.trailer.get(b"Root").and_then(|o| o.as_reference()) {
        if let Ok(catalog) = doc_state.doc.get_dictionary_mut(root_id) {
            catalog.remove(b"AcroForm");
        }
    }
    doc_state.doc.prune_objects();
    affected.sort_unstable();
    Ok(affected)
}

fn append_ops_to_page(
    doc: &mut Document,
    page_id: ObjectId,
    additional_ops: Vec<Operation>,
) -> Result<(), CoreError> {
    let page_dict = doc.get_dictionary(page_id)?;
    let mut existing = if let Ok(contents_obj) = page_dict.get(b"Contents") {
        let bytes = match contents_obj {
            Object::Reference(id) => doc.get_object(*id)?.as_stream()?.decompressed_content()?,
            Object::Stream(s) => s.decompressed_content()?,
            Object::Array(arr) => {
                let mut merged = Vec::new();
                for item in arr {
                    if let Ok(id) = item.as_reference() {
                        merged.extend(doc.get_object(id)?.as_stream()?.decompressed_content()?);
                        merged.push(b'\n');
                    }
                }
                merged
            }
            _ => Vec::new(),
        };
        Content::decode(&bytes).unwrap_or(Content { operations: Vec::new() })
    } else {
        Content { operations: Vec::new() }
    };

    existing.operations.extend(additional_ops);
    let encoded = existing
        .encode()
        .map_err(|e| CoreError::InvalidOperation(format!("Failed to encode flattened form: {}", e)))?;

    let stream_id = doc.add_object(Stream::new(dictionary! {}, encoded));
    let page_dict = doc.get_dictionary_mut(page_id)?;
    page_dict.set("Contents", Object::Reference(stream_id));
    Ok(())
}
