export type ViewMode = "continuous" | "single" | "spread" | "grid";

export type ToolType =
  | "select"
  | "hand"
  | "freeText"
  | "stickyNote"
  | "highlight"
  | "underline"
  | "strikeout"
  | "squiggly"
  | "pen"
  | "highlighter"
  | "rectangle"
  | "circle"
  | "line"
  | "arrow"
  | "stamp"
  | "coverErase"
  | "trueRedact"
  | "crop";

export interface PageBox {
  x: f64;
  y: f64;
  width: f64;
  height: f64;
}
type f64 = number;

export interface PageInfo {
  index: number;
  width: number;
  height: number;
  rotation: number;
  media_box: PageBox;
  crop_box?: PageBox | null;
}

export interface DocumentMetadata {
  title?: string | null;
  author?: string | null;
  subject?: string | null;
  keywords?: string | null;
  creator?: string | null;
  producer?: string | null;
  page_count: number;
  file_size_bytes: number;
  is_encrypted: boolean;
}

export interface AnnotationDto {
  id: string;
  page_index: number;
  annot_type: string;
  rect: PageBox;
  color: string;
  fill_color?: string | null;
  stroke_width: number;
  opacity: number;
  text?: string | null;
  points?: Array<Array<{ x: number; y: number }>> | null;
  author?: string | null;
  modified_date?: string | null;
  locked: boolean;
}

export interface DocumentDto {
  file_path?: string | null;
  file_name: string;
  page_count: number;
  pages: PageInfo[];
  metadata: DocumentMetadata;
  can_undo: bool;
  can_redo: bool;
  is_dirty: bool;
  revision_id: number;
}
type bool = boolean;

export interface SearchResult {
  page_index: number;
  match_text: string;
  bounding_boxes: PageBox[];
}

export type CropRatioMode = "free" | "original" | "1:1" | "4:3" | "16:9";

export interface ToolSettings {
  strokeColor: string;
  fillColor: string | null;
  strokeWidth: number;
  opacity: number;
  fontSize: number;
  fontFamily: string;
  author: string;
  stampText: string;
  coverColor: string;
  units: "pt" | "mm" | "in";
  cropRatioMode: CropRatioMode;
}
