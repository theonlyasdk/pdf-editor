use crate::document::{CoreError, DocumentState};
use crate::types::OutlineItem;
use lopdf::{Dictionary, Document, Object, ObjectId};
use std::collections::{HashMap, HashSet};

/// Decodes a PDF text string, handling UTF-16BE BOM and PDFDocEncoding/UTF-8.
pub fn decode_pdf_string(bytes: &[u8]) -> String {
    if bytes.len() >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF {
        let utf16: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|chunk| u16::from_be_bytes([chunk[0], chunk[1]]))
            .collect();
        return String::from_utf16_lossy(&utf16);
    }
    String::from_utf8_lossy(bytes).into_owned()
}

pub fn extract_outline(doc_state: &DocumentState) -> Result<Vec<OutlineItem>, CoreError> {
    let doc = &doc_state.doc;
    let Ok(root_ref) = doc.trailer.get(b"Root").and_then(|o| o.as_reference()) else {
        return Ok(Vec::new());
    };
    let Ok(catalog) = doc.get_dictionary(root_ref) else {
        return Ok(Vec::new());
    };
    let Ok(outlines_ref) = catalog.get(b"Outlines").and_then(|o| o.as_reference()) else {
        return Ok(Vec::new());
    };
    let Ok(outlines_dict) = doc.get_dictionary(outlines_ref) else {
        return Ok(Vec::new());
    };
    let Ok(first_ref) = outlines_dict.get(b"First").and_then(|o| o.as_reference()) else {
        return Ok(Vec::new());
    };

    let mut page_lookup: HashMap<ObjectId, usize> = HashMap::new();
    for idx in 0..doc_state.page_count() {
        if let Ok(pid) = doc_state.get_page_id(idx) {
            page_lookup.insert(pid, idx);
        }
    }

    let named_dests = collect_named_dests(doc, catalog);
    let mut visited = HashSet::new();
    read_outline_siblings(doc, first_ref, &page_lookup, &named_dests, &mut visited)
}

fn read_outline_siblings(
    doc: &Document,
    first_id: ObjectId,
    page_lookup: &HashMap<ObjectId, usize>,
    named_dests: &HashMap<Vec<u8>, Object>,
    visited: &mut HashSet<ObjectId>,
) -> Result<Vec<OutlineItem>, CoreError> {
    let mut items = Vec::new();
    let mut current = Some(first_id);

    while let Some(id) = current {
        if !visited.insert(id) {
            break;
        }
        let Ok(dict) = doc.get_dictionary(id) else {
            break;
        };

        let title = dict
            .get(b"Title")
            .ok()
            .and_then(|o| match o {
                Object::String(bytes, _) => Some(decode_pdf_string(bytes)),
                _ => o.as_str().ok().map(decode_pdf_string),
            })
            .unwrap_or_default();

        let page_index = resolve_outline_page(doc, dict, page_lookup, named_dests);

        let children = if let Ok(child_ref) = dict.get(b"First").and_then(|o| o.as_reference()) {
            read_outline_siblings(doc, child_ref, page_lookup, named_dests, visited)?
        } else {
            Vec::new()
        };

        items.push(OutlineItem {
            title,
            page_index,
            children,
        });

        current = dict.get(b"Next").ok().and_then(|o| o.as_reference().ok());
    }

    Ok(items)
}

fn resolve_outline_page(
    doc: &Document,
    dict: &Dictionary,
    page_lookup: &HashMap<ObjectId, usize>,
    named_dests: &HashMap<Vec<u8>, Object>,
) -> Option<usize> {
    if let Ok(dest) = dict.get(b"Dest") {
        if let Some(idx) = resolve_dest_object(doc, dest, page_lookup, named_dests) {
            return Some(idx);
        }
    }

    if let Ok(action_obj) = dict.get_deref(b"A", doc) {
        if let Ok(action_dict) = action_obj.as_dict() {
            let is_goto = action_dict
                .get(b"S")
                .ok()
                .and_then(|s| s.as_name().ok())
                .is_none_or(|name| name == b"GoTo");
            if is_goto {
                if let Ok(d_obj) = action_dict.get(b"D") {
                    return resolve_dest_object(doc, d_obj, page_lookup, named_dests);
                }
            }
        }
    }

    None
}

fn resolve_dest_object(
    doc: &Document,
    dest: &Object,
    page_lookup: &HashMap<ObjectId, usize>,
    named_dests: &HashMap<Vec<u8>, Object>,
) -> Option<usize> {
    let resolved = match dest {
        Object::Reference(id) => doc.get_object(*id).ok()?,
        other => other,
    };

    match resolved {
        Object::Array(arr) => resolve_dest_array(arr, page_lookup),
        Object::Dictionary(dict) => {
            if let Ok(Object::Array(arr)) = dict.get_deref(b"D", doc) {
                return resolve_dest_array(arr, page_lookup);
            }
            None
        }
        Object::Name(name) => named_dests
            .get(name.as_slice())
            .and_then(|obj| resolve_dest_object(doc, obj, page_lookup, named_dests)),
        Object::String(bytes, _) => named_dests
            .get(bytes.as_slice())
            .and_then(|obj| resolve_dest_object(doc, obj, page_lookup, named_dests)),
        _ => None,
    }
}

fn resolve_dest_array(arr: &[Object], page_lookup: &HashMap<ObjectId, usize>) -> Option<usize> {
    let first = arr.first()?;
    if let Ok(page_id) = first.as_reference() {
        return page_lookup.get(&page_id).copied();
    }
    if let Ok(page_num) = first.as_i64() {
        if page_num >= 0 && (page_num as usize) < page_lookup.len() {
            return Some(page_num as usize);
        }
    }
    None
}

fn collect_named_dests(doc: &Document, catalog: &Dictionary) -> HashMap<Vec<u8>, Object> {
    let mut map = HashMap::new();

    if let Ok(dests_obj) = catalog.get_deref(b"Dests", doc) {
        if let Ok(dests_dict) = dests_obj.as_dict() {
            for (key, val) in dests_dict.iter() {
                map.insert(key.clone(), val.clone());
            }
        }
    }

    if let Ok(names_obj) = catalog.get_deref(b"Names", doc) {
        if let Ok(names_dict) = names_obj.as_dict() {
            if let Ok(dests_tree) = names_dict.get_deref(b"Dests", doc) {
                if let Ok(tree_dict) = dests_tree.as_dict() {
                    let mut visited = HashSet::new();
                    collect_name_tree(doc, tree_dict, &mut map, &mut visited);
                }
            }
        }
    }

    map
}

fn collect_name_tree(
    doc: &Document,
    node: &Dictionary,
    out: &mut HashMap<Vec<u8>, Object>,
    visited: &mut HashSet<ObjectId>,
) {
    if let Ok(names) = node.get_deref(b"Names", doc).and_then(|o| o.as_array()) {
        for pair in names.chunks_exact(2) {
            if let Ok(key_bytes) = pair[0].as_str() {
                out.insert(key_bytes.to_vec(), pair[1].clone());
            }
        }
    }
    if let Ok(kids) = node.get_deref(b"Kids", doc).and_then(|o| o.as_array()) {
        for kid in kids {
            if let Ok(kid_id) = kid.as_reference() {
                if visited.insert(kid_id) {
                    if let Ok(kid_dict) = doc.get_dictionary(kid_id) {
                        collect_name_tree(doc, kid_dict, out, visited);
                    }
                }
            }
        }
    }
}

/// Encodes a Rust string as a PDF string object (ASCII literal or UTF-16BE with BOM).
pub fn encode_pdf_string(s: &str) -> Object {
    if s.is_ascii() {
        Object::string_literal(s)
    } else {
        let mut bytes = Vec::with_capacity(2 + s.len() * 2);
        bytes.push(0xFE);
        bytes.push(0xFF);
        for unit in s.encode_utf16() {
            bytes.extend_from_slice(&unit.to_be_bytes());
        }
        Object::String(bytes, lopdf::StringFormat::Literal)
    }
}

/// Writes a complete bookmark/outline hierarchy into the PDF catalog.
pub fn write_outline(doc_state: &mut DocumentState, items: &[OutlineItem]) -> Result<(), CoreError> {
    let page_ids: Vec<ObjectId> = (0..doc_state.page_count())
        .map(|i| doc_state.get_page_id(i))
        .collect::<Result<Vec<_>, _>>()?;

    let root_id = doc_state
        .doc
        .trailer
        .get(b"Root")
        .and_then(|o| o.as_reference())
        .map_err(|_| CoreError::InvalidOperation("Missing PDF Catalog Root".to_string()))?;

    if items.is_empty() {
        if let Ok(catalog) = doc_state.doc.get_dictionary_mut(root_id) {
            catalog.remove(b"Outlines");
        }
        doc_state.doc.prune_objects();
        return Ok(());
    }

    let outlines_id = doc_state.doc.new_object_id();
    let (first_id, last_id, total_count) =
        write_outline_siblings(&mut doc_state.doc, outlines_id, items, &page_ids)?;

    let mut outlines_dict = Dictionary::new();
    outlines_dict.set("Type", "Outlines");
    outlines_dict.set("First", first_id);
    outlines_dict.set("Last", last_id);
    outlines_dict.set("Count", total_count as i64);
    doc_state
        .doc
        .objects
        .insert(outlines_id, Object::Dictionary(outlines_dict));

    let catalog = doc_state.doc.get_dictionary_mut(root_id)?;
    catalog.set("Outlines", outlines_id);
    doc_state.doc.prune_objects();
    Ok(())
}

fn write_outline_siblings(
    doc: &mut Document,
    parent_id: ObjectId,
    items: &[OutlineItem],
    page_ids: &[ObjectId],
) -> Result<(ObjectId, ObjectId, usize), CoreError> {
    let ids: Vec<ObjectId> = (0..items.len()).map(|_| doc.new_object_id()).collect();
    let mut total_visible = items.len();

    for (idx, item) in items.iter().enumerate() {
        let mut dict = Dictionary::new();
        dict.set("Title", encode_pdf_string(&item.title));
        dict.set("Parent", parent_id);
        if idx > 0 {
            dict.set("Prev", ids[idx - 1]);
        }
        if idx + 1 < items.len() {
            dict.set("Next", ids[idx + 1]);
        }
        if let Some(page_idx) = item.page_index {
            if let Some(&page_id) = page_ids.get(page_idx) {
                dict.set(
                    "Dest",
                    vec![Object::Reference(page_id), Object::Name(b"Fit".to_vec())],
                );
            }
        }
        if !item.children.is_empty() {
            let (child_first, child_last, child_count) =
                write_outline_siblings(doc, ids[idx], &item.children, page_ids)?;
            dict.set("First", child_first);
            dict.set("Last", child_last);
            dict.set("Count", child_count as i64);
            total_visible += child_count;
        }
        doc.objects.insert(ids[idx], Object::Dictionary(dict));
    }

    Ok((ids[0], ids[ids.len() - 1], total_visible))
}
