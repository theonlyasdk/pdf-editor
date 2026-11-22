use crate::commands::DocumentCommand;
use crate::document::{CoreError, DocumentState};
use crate::types::PageBox;
use lopdf::content::{Content, Operation};
use lopdf::{Dictionary, Object, ObjectId, Stream};

pub struct ResizeCropPages {
    pages: Vec<(usize, PageBox)>,
    previous: Vec<(ObjectId, Dictionary)>,
    added: Vec<ObjectId>,
}

impl ResizeCropPages {
    pub fn new(pages: Vec<(usize, PageBox)>) -> Self {
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
            let (index, crop) = self.pages[target];
            if let Err(error) = self.resize_page(document, index, crop) {
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
}

impl ResizeCropPages {
    fn resize_page(
        &mut self,
        document: &mut DocumentState,
        index: usize,
        crop: PageBox,
    ) -> Result<(), CoreError> {
        let info = document.get_page_info(index)?;
        let visible = info
            .viewport_crop(PageBox::new(0.0, 0.0, info.width, info.height))
            .ok_or_else(|| CoreError::InvalidOperation("Page has no visible area".into()))?;
        if crop == visible {
            return Ok(());
        }

        let id = document.get_page_id(index)?;
        let original = document.doc.get_dictionary(id)?.clone();
        let scale = (visible.width / crop.width).min(visible.height / crop.height);
        let width = crop.width * scale;
        let height = crop.height * scale;
        let x = visible.x + (visible.width - width) / 2.0;
        let y = visible.y + (visible.height - height) / 2.0;
        let tx = x - crop.x * scale;
        let ty = y - crop.y * scale;

        let mut before = Content {
            operations: vec![
                Operation::new("q", vec![]),
                Operation::new("re", vec![x.into(), y.into(), width.into(), height.into()]),
                Operation::new("W", vec![]),
                Operation::new("n", vec![]),
                Operation::new(
                    "cm",
                    vec![
                        scale.into(),
                        0.into(),
                        0.into(),
                        scale.into(),
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
                        scale_annotation(dict.clone(), crop, scale, tx, ty).map(|dict| (id, dict))
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
    scale: f64,
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

    let transform = |list: &Vec<Object>| -> Option<Vec<Object>> {
        list.iter()
            .enumerate()
            .map(|(index, value)| {
                let offset = if index % 2 == 0 { tx } else { ty };
                Some(Object::from(
                    f64::from(value.as_float().ok()?) * scale + offset,
                ))
            })
            .collect()
    };
    for key in ["Rect", "QuadPoints", "L", "Vertices", "CL"] {
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
