use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct PageBox {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl PageBox {
    pub fn new(x: f64, y: f64, width: f64, height: f64) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }

    pub fn to_rect_array(&self) -> Vec<f64> {
        vec![self.x, self.y, self.x + self.width, self.y + self.height]
    }

    pub fn from_rect_array(rect: &[f64]) -> Option<Self> {
        if rect.len() >= 4 {
            let x1 = rect[0].min(rect[2]);
            let y1 = rect[1].min(rect[3]);
            let x2 = rect[0].max(rect[2]);
            let y2 = rect[1].max(rect[3]);
            Some(Self {
                x: x1,
                y: y1,
                width: x2 - x1,
                height: y2 - y1,
            })
        } else {
            None
        }
    }

    pub fn contains_point(&self, px: f64, py: f64) -> bool {
        px >= self.x && px <= (self.x + self.width) && py >= self.y && py <= (self.y + self.height)
    }

    pub fn intersection(&self, other: &Self) -> Option<Self> {
        let x = self.x.max(other.x);
        let y = self.y.max(other.y);
        let right = (self.x + self.width).min(other.x + other.width);
        let top = (self.y + self.height).min(other.y + other.height);
        (right > x && top > y).then(|| Self::new(x, y, right - x, top - y))
    }

    pub fn intersects(&self, other: &PageBox) -> bool {
        self.x < (other.x + other.width)
            && (self.x + self.width) > other.x
            && self.y < (other.y + other.height)
            && (self.y + self.height) > other.y
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PageInfo {
    pub index: usize,
    pub width: f64,
    pub height: f64,
    pub rotation: i32,
    pub media_box: PageBox,
    pub crop_box: Option<PageBox>,
}

impl PageInfo {
    pub fn viewport_point(&self, x: f64, y: f64) -> Point2D {
        let visible = self
            .crop_box
            .and_then(|rect| rect.intersection(&self.media_box))
            .unwrap_or(self.media_box);
        let (x, y) = match self.rotation.rem_euclid(360) {
            90 => (y, x),
            180 => (visible.width - x, y),
            270 => (visible.width - y, visible.height - x),
            _ => (x, visible.height - y),
        };
        Point2D {
            x: visible.x + x,
            y: visible.y + y,
        }
    }

    pub fn pdf_rect_to_viewport(&self, rect: PageBox) -> PageBox {
        let visible = self
            .crop_box
            .and_then(|rect| rect.intersection(&self.media_box))
            .unwrap_or(self.media_box);
        let x = rect.x - visible.x;
        let y = rect.y - visible.y;
        match self.rotation.rem_euclid(360) {
            90 => PageBox::new(y, x, rect.height, rect.width),
            180 => PageBox::new(visible.width - x - rect.width, y, rect.width, rect.height),
            270 => PageBox::new(
                visible.height - y - rect.height,
                visible.width - x - rect.width,
                rect.height,
                rect.width,
            ),
            _ => PageBox::new(x, visible.height - y - rect.height, rect.width, rect.height),
        }
    }

    /// Converts a top-left viewport crop into a bottom-left PDF page rectangle.
    pub fn viewport_crop(&self, crop: PageBox) -> Option<PageBox> {
        let crop = crop.intersection(&PageBox::new(0.0, 0.0, self.width, self.height))?;
        let visible = self
            .crop_box
            .and_then(|box_| box_.intersection(&self.media_box))
            .unwrap_or(self.media_box);
        let (x, y, width, height) = match self.rotation.rem_euclid(360) {
            90 => (crop.y, crop.x, crop.height, crop.width),
            180 => (
                visible.width - crop.x - crop.width,
                crop.y,
                crop.width,
                crop.height,
            ),
            270 => (
                visible.width - crop.y - crop.height,
                visible.height - crop.x - crop.width,
                crop.height,
                crop.width,
            ),
            _ => (
                crop.x,
                visible.height - crop.y - crop.height,
                crop.width,
                crop.height,
            ),
        };
        Some(PageBox::new(visible.x + x, visible.y + y, width, height))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DocumentMetadata {
    pub title: Option<String>,
    pub author: Option<String>,
    pub subject: Option<String>,
    pub keywords: Option<String>,
    pub creator: Option<String>,
    pub producer: Option<String>,
    pub page_count: usize,
    pub file_size_bytes: u64,
    pub is_encrypted: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum AnnotationType {
    Highlight,
    Underline,
    StrikeOut,
    Squiggly,
    FreeText,
    StickyNote,
    Square,
    Circle,
    Line,
    Arrow,
    Ink,
    Stamp,
    Image,
    Cover,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Point2D {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnnotationDto {
    pub id: String,
    pub page_index: usize,
    pub annot_type: AnnotationType,
    pub rect: PageBox,
    pub color: String, // hex "#rrggbbaa" or "#rrggbb"
    pub fill_color: Option<String>,
    pub stroke_width: f64,
    pub opacity: f64,
    pub text: Option<String>,
    #[serde(default)]
    pub font_size: Option<f64>,
    #[serde(default)]
    pub font_family: Option<String>,
    pub points: Option<Vec<Vec<Point2D>>>, // for ink or lines/polygons
    pub author: Option<String>,
    pub modified_date: Option<String>,
    pub locked: bool,
    #[serde(default)]
    pub image_base64: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DocumentMetadataUpdate {
    pub title: Option<String>,
    pub author: Option<String>,
    pub subject: Option<String>,
    pub keywords: Option<String>,
    pub creator: Option<String>,
    pub producer: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AreaRedactItem {
    pub page_index: usize,
    pub rect: PageBox,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OverlayKind {
    Watermark,
    PageNumbers,
    HeaderFooter,
    Bates,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OverlayPosition {
    Center,
    TopLeft,
    TopCenter,
    TopRight,
    BottomLeft,
    BottomCenter,
    BottomRight,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchOverlayOptions {
    pub kind: OverlayKind,
    #[serde(default)]
    pub pages: Option<Vec<usize>>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub position: Option<OverlayPosition>,
    #[serde(default)]
    pub font_size: Option<f64>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub opacity: Option<f64>,
    #[serde(default)]
    pub rotation: Option<f64>,
    #[serde(default)]
    pub margin: Option<f64>,
    #[serde(default)]
    pub bates_prefix: Option<String>,
    #[serde(default)]
    pub bates_start: Option<u64>,
    #[serde(default)]
    pub bates_digits: Option<usize>,
    #[serde(default)]
    pub header_left: Option<String>,
    #[serde(default)]
    pub header_center: Option<String>,
    #[serde(default)]
    pub header_right: Option<String>,
    #[serde(default)]
    pub footer_left: Option<String>,
    #[serde(default)]
    pub footer_center: Option<String>,
    #[serde(default)]
    pub footer_right: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OutlineItem {
    pub title: String,
    pub page_index: Option<usize>,
    pub children: Vec<OutlineItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    pub page_index: usize,
    pub match_text: String,
    pub bounding_boxes: Vec<PageBox>,
}
