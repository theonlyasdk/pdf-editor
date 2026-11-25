use crate::commands::{CommandRenderEffect, DocumentCommand};
use crate::document::{CoreError, DocumentState};
use crate::types::{BatchOverlayOptions, OverlayKind, OverlayPosition, PageInfo};
use lopdf::content::{Content, Operation};
use lopdf::{dictionary, Dictionary, Object, ObjectId, Stream};

struct PageSnapshot {
    page_id: ObjectId,
    prev_page_dict: Dictionary,
    prev_resources: Option<(ObjectId, Dictionary)>,
    added_objects: Vec<ObjectId>,
}

pub struct BatchOverlayCommand {
    options: BatchOverlayOptions,
    snapshots: Vec<PageSnapshot>,
}

impl BatchOverlayCommand {
    pub fn new(options: BatchOverlayOptions) -> Self {
        Self {
            options,
            snapshots: Vec::new(),
        }
    }
}

impl DocumentCommand for BatchOverlayCommand {
    fn execute(&mut self, doc: &mut DocumentState) -> Result<(), CoreError> {
        self.snapshots.clear();
        let target_pages = resolve_target_pages(doc, &self.options)?;
        let total_pages = doc.page_count();

        let shared_font_id = doc.doc.add_object(dictionary! {
            "Type" => "Font",
            "Subtype" => "Type1",
            "BaseFont" => "Helvetica",
            "Encoding" => "WinAnsiEncoding",
        });

        let opacity = default_opacity(&self.options);
        let shared_gs_id = doc.doc.add_object(dictionary! {
            "Type" => "ExtGState",
            "CA" => Object::Real(opacity as f32),
            "ca" => Object::Real(opacity as f32),
        });

        let mut shared_assigned = false;

        for (seq_idx, &page_index) in target_pages.iter().enumerate() {
            let page_info = doc.get_page_info(page_index)?;
            let page_id = doc.get_page_id(page_index)?;
            let prev_page_dict = doc.doc.get_dictionary(page_id)?.clone();

            let ops = build_overlay_ops(&self.options, &page_info, page_index, seq_idx, total_pages);
            if ops.is_empty() {
                continue;
            }

            let stream_bytes = Content { operations: ops }.encode().map_err(|e| {
                CoreError::InvalidOperation(format!("Failed to encode overlay stream: {}", e))
            })?;
            let overlay_stream_id = doc
                .doc
                .add_object(Stream::new(dictionary! {}, stream_bytes));

            let mut added_objects = vec![overlay_stream_id];
            if !shared_assigned {
                added_objects.push(shared_font_id);
                added_objects.push(shared_gs_id);
                shared_assigned = true;
            }

            // Ensure page has its own /Resources dict with /F_Overlay and /GS_Overlay
            let prev_resources = attach_overlay_resources(
                &mut doc.doc,
                page_id,
                shared_font_id,
                shared_gs_id,
            )?;

            // Wrap existing page contents in q ... Q if needed or simply append overlay stream
            let mut content_refs = vec![];
            let q_id = doc
                .doc
                .add_object(Stream::new(dictionary! {}, b"q\n".to_vec()));
            let big_q_id = doc
                .doc
                .add_object(Stream::new(dictionary! {}, b"\nQ\n".to_vec()));
            added_objects.push(q_id);
            added_objects.push(big_q_id);

            let existing_contents = doc.doc.get_page_contents(page_id);
            if !existing_contents.is_empty() {
                content_refs.push(Object::Reference(q_id));
                content_refs.extend(existing_contents.into_iter().map(Object::Reference));
                content_refs.push(Object::Reference(big_q_id));
            }
            content_refs.push(Object::Reference(overlay_stream_id));

            doc.doc
                .get_dictionary_mut(page_id)?
                .set("Contents", content_refs);

            self.snapshots.push(PageSnapshot {
                page_id,
                prev_page_dict,
                prev_resources,
                added_objects,
            });
        }

        if !shared_assigned {
            doc.doc.objects.remove(&shared_font_id);
            doc.doc.objects.remove(&shared_gs_id);
        }

        Ok(())
    }

    fn undo(&mut self, doc: &mut DocumentState) -> Result<(), CoreError> {
        for snap in self.snapshots.drain(..).rev() {
            doc.doc
                .objects
                .insert(snap.page_id, Object::Dictionary(snap.prev_page_dict));
            if let Some((res_id, res_dict)) = snap.prev_resources {
                doc.doc
                    .objects
                    .insert(res_id, Object::Dictionary(res_dict));
            }
            for added_id in snap.added_objects {
                doc.doc.objects.remove(&added_id);
            }
        }
        Ok(())
    }

    fn description(&self) -> String {
        match self.options.kind {
            OverlayKind::Watermark => "Apply Watermark".to_string(),
            OverlayKind::PageNumbers => "Add Page Numbers".to_string(),
            OverlayKind::HeaderFooter => "Add Headers/Footers".to_string(),
            OverlayKind::Bates => "Apply Bates Numbering".to_string(),
        }
    }

    fn render_effect(&self) -> CommandRenderEffect {
        match &self.options.pages {
            Some(pages) => CommandRenderEffect::Pages(pages.clone()),
            None => CommandRenderEffect::Structural,
        }
    }
}

pub fn apply_batch_overlay(
    doc: &mut DocumentState,
    options: BatchOverlayOptions,
) -> Result<(), CoreError> {
    let mut cmd = BatchOverlayCommand::new(options);
    cmd.execute(doc)
}

fn resolve_target_pages(
    doc: &DocumentState,
    options: &BatchOverlayOptions,
) -> Result<Vec<usize>, CoreError> {
    let total = doc.page_count();
    match &options.pages {
        Some(list) if !list.is_empty() => {
            for &idx in list {
                if idx >= total {
                    return Err(CoreError::PageOutOfRange(idx, total));
                }
            }
            Ok(list.clone())
        }
        _ => Ok((0..total).collect()),
    }
}

fn default_opacity(options: &BatchOverlayOptions) -> f64 {
    let raw = options.opacity.unwrap_or(match options.kind {
        OverlayKind::Watermark => 0.25,
        _ => 1.0,
    });
    raw.clamp(0.0, 1.0)
}

fn parse_hex_color(hex: Option<&str>) -> (f64, f64, f64) {
    let clean = hex.unwrap_or("#475569").trim_start_matches('#');
    if clean.len() >= 6 {
        let r = u8::from_str_radix(&clean[0..2], 16).unwrap_or(71) as f64 / 255.0;
        let g = u8::from_str_radix(&clean[2..4], 16).unwrap_or(85) as f64 / 255.0;
        let b = u8::from_str_radix(&clean[4..6], 16).unwrap_or(105) as f64 / 255.0;
        (r, g, b)
    } else {
        (0.28, 0.33, 0.41)
    }
}

fn attach_overlay_resources(
    doc: &mut lopdf::Document,
    page_id: ObjectId,
    font_id: ObjectId,
    gs_id: ObjectId,
) -> Result<Option<(ObjectId, Dictionary)>, CoreError> {
    // Check if page directly has a Resources dictionary reference or inline dictionary,
    // or inherits Resources from Parent.
    let page_dict = doc.get_dictionary(page_id)?.clone();

    if let Ok(Object::Reference(res_id)) = page_dict.get(b"Resources") {
        let prev = doc.get_dictionary(*res_id)?.clone();
        let mut updated = prev.clone();
        insert_overlay_entries(doc, &mut updated, font_id, gs_id);
        doc.objects.insert(*res_id, Object::Dictionary(updated));
        return Ok(Some((*res_id, prev)));
    }

    let mut res_dict = if let Ok(Object::Dictionary(inline)) = page_dict.get(b"Resources") {
        inline.clone()
    } else {
        // Inherit from parent chain if present so existing page fonts/xobjects aren't shadowed
        find_inherited_resources(doc, &page_dict).unwrap_or_default()
    };

    insert_overlay_entries(doc, &mut res_dict, font_id, gs_id);
    doc.get_dictionary_mut(page_id)?
        .set("Resources", Object::Dictionary(res_dict));
    Ok(None)
}

fn find_inherited_resources(doc: &lopdf::Document, page_dict: &Dictionary) -> Option<Dictionary> {
    let mut parent_ref = page_dict.get(b"Parent").ok()?.as_reference().ok();
    let mut visited = std::collections::HashSet::new();
    while let Some(pid) = parent_ref {
        if !visited.insert(pid) {
            break;
        }
        let parent_dict = doc.get_dictionary(pid).ok()?;
        if let Ok(res_obj) = parent_dict.get_deref(b"Resources", doc) {
            if let Ok(res_dict) = res_obj.as_dict() {
                return Some(res_dict.clone());
            }
        }
        parent_ref = parent_dict
            .get(b"Parent")
            .ok()
            .and_then(|o| o.as_reference().ok());
    }
    None
}

fn insert_overlay_entries(
    doc: &lopdf::Document,
    res_dict: &mut Dictionary,
    font_id: ObjectId,
    gs_id: ObjectId,
) {
    let mut font_dict = res_dict
        .get_deref(b"Font", doc)
        .ok()
        .and_then(|o| o.as_dict().ok())
        .cloned()
        .unwrap_or_default();
    font_dict.set("F_Overlay", Object::Reference(font_id));
    res_dict.set("Font", Object::Dictionary(font_dict));

    let mut gs_dict = res_dict
        .get_deref(b"ExtGState", doc)
        .ok()
        .and_then(|o| o.as_dict().ok())
        .cloned()
        .unwrap_or_default();
    gs_dict.set("GS_Overlay", Object::Reference(gs_id));
    res_dict.set("ExtGState", Object::Dictionary(gs_dict));
}

fn expand_placeholders(template: &str, page_index: usize, total_pages: usize) -> String {
    let page_str = (page_index + 1).to_string();
    let total_str = total_pages.to_string();
    template
        .replace("{page}", &page_str)
        .replace("{n}", &page_str)
        .replace("{total}", &total_str)
        .replace("{pages}", &total_str)
}

fn build_overlay_ops(
    options: &BatchOverlayOptions,
    page: &PageInfo,
    page_index: usize,
    seq_idx: usize,
    total_pages: usize,
) -> Vec<Operation> {
    let (r, g, b) = parse_hex_color(options.color.as_deref());
    let margin = options.margin.unwrap_or(36.0);
    let font_size = options.font_size.unwrap_or(match options.kind {
        OverlayKind::Watermark => 48.0,
        _ => 10.0,
    });
    let rotation = options.rotation.unwrap_or(match options.kind {
        OverlayKind::Watermark => 45.0,
        _ => 0.0,
    });

    let mut placements: Vec<(String, OverlayPosition, f64)> = Vec::new();

    match options.kind {
        OverlayKind::Watermark => {
            let text = options.text.as_deref().unwrap_or("CONFIDENTIAL").trim();
            if !text.is_empty() {
                placements.push((
                    expand_placeholders(text, page_index, total_pages),
                    options.position.unwrap_or(OverlayPosition::Center),
                    rotation,
                ));
            }
        }
        OverlayKind::PageNumbers => {
            let tpl = options.text.as_deref().unwrap_or("Page {page} of {total}");
            let label = expand_placeholders(tpl, page_index, total_pages);
            if !label.trim().is_empty() {
                placements.push((
                    label,
                    options.position.unwrap_or(OverlayPosition::BottomCenter),
                    rotation,
                ));
            }
        }
        OverlayKind::Bates => {
            let prefix = options.bates_prefix.as_deref().unwrap_or("");
            let start = options.bates_start.unwrap_or(1);
            let digits = options.bates_digits.unwrap_or(6).clamp(1, 16);
            let num = start.saturating_add(seq_idx as u64);
            let label = format!("{prefix}{num:0width$}", width = digits);
            placements.push((
                label,
                options.position.unwrap_or(OverlayPosition::BottomRight),
                rotation,
            ));
        }
        OverlayKind::HeaderFooter => {
            let slots = [
                (&options.header_left, OverlayPosition::TopLeft),
                (&options.header_center, OverlayPosition::TopCenter),
                (&options.header_right, OverlayPosition::TopRight),
                (&options.footer_left, OverlayPosition::BottomLeft),
                (&options.footer_center, OverlayPosition::BottomCenter),
                (&options.footer_right, OverlayPosition::BottomRight),
            ];
            for (slot_text, pos) in slots {
                if let Some(txt) = slot_text {
                    if !txt.trim().is_empty() {
                        placements.push((
                            expand_placeholders(txt, page_index, total_pages),
                            pos,
                            rotation,
                        ));
                    }
                }
            }
            if placements.is_empty() {
                if let Some(txt) = &options.text {
                    if !txt.trim().is_empty() {
                        placements.push((
                            expand_placeholders(txt, page_index, total_pages),
                            options.position.unwrap_or(OverlayPosition::TopCenter),
                            rotation,
                        ));
                    }
                }
            }
        }
    }

    if placements.is_empty() {
        return Vec::new();
    }

    let mut ops = vec![
        Operation::new("q", vec![]),
        Operation::new("gs", vec!["GS_Overlay".into()]),
        Operation::new("rg", vec![r.into(), g.into(), b.into()]),
    ];

    for (text, position, rot_deg) in placements {
        let approx_width = text.chars().count() as f64 * font_size * 0.52;
        let (vx, vy, align_dx, align_dy) = match position {
            OverlayPosition::Center => (
                page.width / 2.0,
                page.height / 2.0,
                -approx_width / 2.0,
                -font_size * 0.35,
            ),
            OverlayPosition::TopLeft => (margin, margin + font_size * 0.85, 0.0, 0.0),
            OverlayPosition::TopCenter => (
                page.width / 2.0,
                margin + font_size * 0.85,
                -approx_width / 2.0,
                0.0,
            ),
            OverlayPosition::TopRight => (
                page.width - margin,
                margin + font_size * 0.85,
                -approx_width,
                0.0,
            ),
            OverlayPosition::BottomLeft => (margin, page.height - margin, 0.0, 0.0),
            OverlayPosition::BottomCenter => (
                page.width / 2.0,
                page.height - margin,
                -approx_width / 2.0,
                0.0,
            ),
            OverlayPosition::BottomRight => {
                (page.width - margin, page.height - margin, -approx_width, 0.0)
            }
        };

        let anchor = page.viewport_point(vx, vy);
        let total_deg = page.rotation as f64 + rot_deg;
        let rad = total_deg.to_radians();
        let cos = rad.cos();
        let sin = rad.sin();

        // Offset (align_dx, align_dy) in rotated text space
        let tx = anchor.x + align_dx * cos - align_dy * sin;
        let ty = anchor.y + align_dx * sin + align_dy * cos;

        ops.push(Operation::new("BT", vec![]));
        ops.push(Operation::new(
            "Tf",
            vec!["F_Overlay".into(), font_size.into()],
        ));
        ops.push(Operation::new(
            "Tm",
            vec![
                cos.into(),
                sin.into(),
                (-sin).into(),
                cos.into(),
                tx.into(),
                ty.into(),
            ],
        ));
        ops.push(Operation::new("Tj", vec![Object::string_literal(text)]));
        ops.push(Operation::new("ET", vec![]));
    }

    ops.push(Operation::new("Q", vec![]));
    ops
}
