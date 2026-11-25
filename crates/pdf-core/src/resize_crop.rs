use crate::commands::{CommandRenderEffect, DocumentCommand};
use crate::document::{CoreError, DocumentState};
use crate::types::PageBox;
use lopdf::content::{Content, Operation};
use lopdf::{Dictionary, Object, ObjectId, Stream};

pub struct ResizeCropPages {
    pages: Vec<(usize, PageBox, f64)>,
    previous: Vec<(ObjectId, Dictionary)>,
    added: Vec<ObjectId>,
}

impl ResizeCropPages {
    pub fn new(pages: Vec<(usize, PageBox)>) -> Self {
        Self::with_rotation(pages.into_iter().map(|(i, b)| (i, b, 0.0)).collect())
    }

    pub fn with_rotation(pages: Vec<(usize, PageBox, f64)>) -> Self {
        Self {
            pages,
            previous: Vec::new(),
            added: Vec::new(),
        }
    }
}

impl DocumentCommand for ResizeCropPages {
    fn execute(&mut self, document: &mut DocumentState) -> Result<(), CoreError> {
        for target in 0..self.pages.len() {
            let (index, crop, rotation_deg) = self.pages[target];
            if let Err(error) = self.resize_page(document, index, crop, rotation_deg) {
                self.undo(document)?;
                return Err(error);
            }
        }
        Ok(())
    }

    fn undo(&mut self, document: &mut DocumentState) -> Result<(), CoreError> {
        for (id, page) in self.previous.drain(..).rev() {
            document.doc.objects.insert(id, Object::Dictionary(page));
        }
        for id in self.added.drain(..) {
            document.doc.objects.remove(&id);
        }
        Ok(())
    }

    fn description(&self) -> String {
        "Crop and Scale Pages".to_string()
    }

    fn render_effect(&self) -> CommandRenderEffect {
        CommandRenderEffect::Pages(self.pages.iter().map(|(idx, _, _)| *idx).collect())
    }
}

impl ResizeCropPages {
    fn resize_page(
        &mut self,
        document: &mut DocumentState,
        index: usize,
        crop: PageBox,
        rotation_deg: f64,
    ) -> Result<(), CoreError> {
        let info = document.get_page_info(index)?;
        let visible = info
            .viewport_crop(PageBox::new(0.0, 0.0, info.width, info.height))
            .ok_or_else(|| CoreError::InvalidOperation("Page has no visible area".into()))?;
        if crop == visible && rotation_deg.abs() < 1e-4 {
            return Ok(());
        }

        let id = document.get_page_id(index)?;
        let original = document.doc.get_dictionary(id)?.clone();
        let scale = (visible.width / crop.width).min(visible.height / crop.height);
        let width = crop.width * scale;
        let height = crop.height * scale;
        let x = visible.x + (visible.width - width) / 2.0;
        let y = visible.y + (visible.height - height) / 2.0;
        let dest_cx = visible.x + visible.width / 2.0;
        let dest_cy = visible.y + visible.height / 2.0;
        let crop_cx = crop.x + crop.width / 2.0;
        let crop_cy = crop.y + crop.height / 2.0;

        let (a, b, c, d) = if rotation_deg.abs() < 1e-4 {
            (scale, 0.0, 0.0, scale)
        } else {
            let phi = -rotation_deg.to_radians();
            let ca = scale * phi.cos();
            let sa = scale * phi.sin();
            (ca, sa, -sa, ca)
        };
        let tx = dest_cx - (a * crop_cx + c * crop_cy);
        let ty = dest_cy - (b * crop_cx + d * crop_cy);

        let mut before = Content {
            operations: vec![
                Operation::new("q", vec![]),
                Operation::new("re", vec![x.into(), y.into(), width.into(), height.into()]),
                Operation::new("W", vec![]),
                Operation::new("n", vec![]),
                Operation::new(
                    "cm",
                    vec![
                        a.into(),
                        b.into(),
                        c.into(),
                        d.into(),
                        tx.into(),
                        ty.into(),
                    ],
                ),
            ],
        }
        .encode()?;
        before.push(b'\n');
        let annotations = original
            .get_deref(b"Annots", &document.doc)
            .ok()
            .and_then(|value| value.as_array().ok())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| {
                        let (id, dict) = match item {
                            Object::Reference(id) => {
                                (Some(*id), document.doc.get_dictionary(*id).ok()?)
                            }
                            Object::Dictionary(dict) => (None, dict),
                            _ => return None,
                        };
                        scale_annotation(dict.clone(), crop, a, b, c, d, tx, ty).map(|dict| (id, dict))
                    })
                    .collect::<Vec<_>>()
            });

        let mut page = original.clone();
        let head = document
            .doc
            .add_object(Stream::new(Dictionary::new(), before));
        let tail = document
            .doc
            .add_object(Stream::new(Dictionary::new(), b"\nQ\n".to_vec()));
        self.added.extend([head, tail]);
        let mut contents = vec![Object::Reference(head)];
        contents.extend(
            document
                .doc
                .get_page_contents(id)
                .into_iter()
                .map(Object::Reference),
        );
        contents.push(Object::Reference(tail));
        page.set("Contents", contents);

        if let Some(annotations) = annotations {
            let mut entries = Vec::with_capacity(annotations.len());
            for (id, annotation) in annotations {
                if let Some(id) = id {
                    let current = document.doc.get_dictionary_mut(id)?;
                    self.previous
                        .push((id, std::mem::replace(current, annotation)));
                    entries.push(Object::Reference(id));
                } else {
                    entries.push(Object::Dictionary(annotation));
                }
            }
            page.set("Annots", entries);
        }
        self.previous.push((id, original));
        *document.doc.get_dictionary_mut(id)? = page;
        Ok(())
    }
}

fn scale_annotation(
    mut annotation: Dictionary,
    crop: PageBox,
    a: f64,
    b: f64,
    c: f64,
    d: f64,
    tx: f64,
    ty: f64,
) -> Option<Dictionary> {
    let bounds = annotation
        .get(b"Rect")
        .ok()
        .and_then(|value| value.as_array().ok())
        .and_then(|list| {
            let coords = list
                .iter()
                .map(|value| value.as_float().ok().map(f64::from))
                .collect::<Option<Vec<_>>>()?;
            PageBox::from_rect_array(&coords)
        });
    if bounds.is_some_and(|bounds| !crop.intersects(&bounds)) {
        return None;
    }

    let apply_pt = |px: f64, py: f64| -> (f64, f64) {
        (a * px + c * py + tx, b * px + d * py + ty)
    };

    if let Some(rect_arr) = annotation
        .get(b"Rect")
        .ok()
        .and_then(|value| value.as_array().ok())
    {
        if let Some(coords) = rect_arr
            .iter()
            .map(|v| v.as_float().ok().map(f64::from))
            .collect::<Option<Vec<_>>>()
        {
            if coords.len() >= 4 {
                let corners = [
                    apply_pt(coords[0], coords[1]),
                    apply_pt(coords[2], coords[1]),
                    apply_pt(coords[2], coords[3]),
                    apply_pt(coords[0], coords[3]),
                ];
                let min_x = corners.iter().map(|p| p.0).fold(f64::INFINITY, f64::min);
                let min_y = corners.iter().map(|p| p.1).fold(f64::INFINITY, f64::min);
                let max_x = corners.iter().map(|p| p.0).fold(f64::NEG_INFINITY, f64::max);
                let max_y = corners.iter().map(|p| p.1).fold(f64::NEG_INFINITY, f64::max);
                annotation.set(
                    "Rect",
                    vec![
                        Object::from(min_x),
                        Object::from(min_y),
                        Object::from(max_x),
                        Object::from(max_y),
                    ],
                );
            }
        }
    }

    let transform = |list: &Vec<Object>| -> Option<Vec<Object>> {
        let coords = list
            .iter()
            .map(|value| value.as_float().ok().map(f64::from))
            .collect::<Option<Vec<_>>>()?;
        let mut out = Vec::with_capacity(coords.len());
        for pair in coords.chunks_exact(2) {
            let (nx, ny) = apply_pt(pair[0], pair[1]);
            out.push(Object::from(nx));
            out.push(Object::from(ny));
        }
        if coords.len() % 2 == 1 {
            out.push(Object::from(coords[coords.len() - 1]));
        }
        Some(out)
    };
    for key in ["QuadPoints", "L", "Vertices", "CL"] {
        if let Some(list) = annotation
            .get(key.as_bytes())
            .ok()
            .and_then(|value| value.as_array().ok())
            .and_then(&transform)
        {
            annotation.set(key, list);
        }
    }
    if let Some(ink) = annotation
        .get(b"InkList")
        .ok()
        .and_then(|value| value.as_array().ok())
    {
        let strokes = ink
            .iter()
            .filter_map(|stroke| {
                stroke
                    .as_array()
                    .ok()
                    .and_then(&transform)
                    .map(Object::Array)
            })
            .collect::<Vec<_>>();
        annotation.set("InkList", strokes);
    }
    Some(annotation)
}
