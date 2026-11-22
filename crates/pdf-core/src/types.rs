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
    pub points: Option<Vec<Vec<Point2D>>>, // for ink or lines/polygons
    pub author: Option<String>,
    pub modified_date: Option<String>,
    pub locked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    pub page_index: usize,
    pub match_text: String,
    pub bounding_boxes: Vec<PageBox>,
}
