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
  label?: string | null;
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
  font_size?: number;
  font_family?: string;
  points?: Array<Array<{ x: number; y: number }>> | null;
  author?: string | null;
  modified_date?: string | null;
  locked: boolean;
  image_base64?: string | null;
}

export interface DocumentMetadataUpdate {
  title?: string | null;
  author?: string | null;
  subject?: string | null;
  keywords?: string | null;
  creator?: string | null;
  producer?: string | null;
}

export interface AreaRedactItem {
  page_index: number;
  rect: PageBox;
}

export type OverlayKind = "watermark" | "page_numbers" | "header_footer" | "bates";

export type OverlayPosition =
  | "center"
  | "top_left"
  | "top_center"
  | "top_right"
  | "bottom_left"
  | "bottom_center"
  | "bottom_right";

export interface BatchOverlayOptions {
  kind: OverlayKind;
  pages?: number[] | null;
  text?: string | null;
  position?: OverlayPosition | null;
  font_size?: number | null;
  color?: string | null;
  opacity?: number | null;
  rotation?: number | null;
  margin?: number | null;
  bates_prefix?: string | null;
  bates_start?: number | null;
  bates_digits?: number | null;
  header_left?: string | null;
  header_center?: string | null;
  header_right?: string | null;
  footer_left?: string | null;
  footer_center?: string | null;
  footer_right?: string | null;
}

export interface OutlineItem {
  title: string;
  page_index: number | null;
  children: OutlineItem[];
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
  page_revisions?: number[];
  annotations?: AnnotationDto[];
}
type bool = boolean;

export interface SearchResult {
  page_index: number;
  match_text: string;
  bounding_boxes: PageBox[];
}

export interface TextSpanDto {
  text: string;
  rect: PageBox;
}

export interface LinkDto {
  rect: PageBox;
  uri?: string | null;
  target_page?: number | null;
}

export type FormFieldType = "text" | "checkbox" | "radio" | "dropdown" | "listbox";

export interface FormFieldDto {
  id: string;
  name: string;
  field_type: FormFieldType;
  page_index: number;
  rect: PageBox;
  value: string;
  export_value?: string | null;
  options: string[];
  multiline: boolean;
  read_only: boolean;
  max_len?: number | null;
  font_size?: number | null;
}

export type CropRatioMode = "free" | "original" | "1:1" | "4:3" | "16:9";
export type MeasurementUnit = "pt" | "mm" | "in";
export type ThemeMode = "system" | "light" | "dark";
export type DefaultZoomMode = "100%" | "fit-width" | "fit-page";
export type ZoomFitMode = "custom" | "fit-width" | "fit-page";
export type SidebarTab = "thumbnails" | "outline" | "annotations";

export interface EditorPreferences {
  themeMode: ThemeMode;
  defaultViewMode: ViewMode;
  defaultZoom: DefaultZoomMode;
  defaultTool: "select" | "hand";
  smoothZoom: boolean;
  animateViewTransitions: boolean;
  gridRadialFlyIn: boolean;
  reopenLastPdf: boolean;
  showLinks: boolean;
  showForms: boolean;
  gridColumns: number;
  zoomSensitivity: number;
  cacheAllPages: boolean;
  units: MeasurementUnit;
  author: string;
  makeBackup: boolean;
  autosaveIntervalSec: number;
  autoCheckUpdates: boolean;
}

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
  units: MeasurementUnit;
  cropRatioMode: CropRatioMode;
}
