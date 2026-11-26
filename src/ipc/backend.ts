import { invoke, isTauri } from "@tauri-apps/api/core";
import { AnnotationDto, DocumentDto, FormFieldDto, LinkDto, PageBox, SearchResult, TextSpanDto } from "../types/editor";

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

export type BatchOverlayKind = "watermark" | "page_numbers" | "header_footer" | "bates";

export type BatchOverlayPosition =
  | "center"
  | "top_left"
  | "top_center"
  | "top_right"
  | "bottom_left"
  | "bottom_center"
  | "bottom_right";

export interface BatchOverlayOptions {
  kind: BatchOverlayKind;
  pages?: number[] | null;
  text?: string | null;
  position?: BatchOverlayPosition | null;
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

async function callIpc<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  if (isTauri()) {
    return invoke<T>(cmd, args);
  }
  throw new Error(`Tauri IPC not available for '${cmd}' outside desktop app`);
}

export interface RenderPageOptions {
  generation?: number;
  queueId?: number;
}

export function isRenderCancelledError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg === "cancelled" || msg.includes("cancelled");
}

export const Backend = {
  async openDocument(path: string, password?: string): Promise<DocumentDto> {
    return callIpc<DocumentDto>("open_document", { path, password });
  },

  async newDocument(): Promise<DocumentDto> {
    return callIpc<DocumentDto>("new_document");
  },

  async renderPage(pageIndex: number, targetWidth: number): Promise<string> {
    const buf = await this.renderPagePng(pageIndex, targetWidth);
    return URL.createObjectURL(new Blob([buf], { type: "image/png" }));
  },

  async renderPageRaw(
    pageIndex: number,
    targetWidth: number,
    options?: RenderPageOptions
  ): Promise<ArrayBuffer> {
    return callIpc<ArrayBuffer>("render_page", {
      pageIndex,
      targetWidth,
      format: "rgba",
      generation: options?.generation ?? null,
      queueId: options?.queueId ?? null,
    });
  },

  async renderPagePng(pageIndex: number, targetWidth: number): Promise<ArrayBuffer> {
    return callIpc<ArrayBuffer>("render_page", { pageIndex, targetWidth, format: "png" });
  },

  async reorderPages(newOrder: number[]): Promise<DocumentDto> {
    return callIpc<DocumentDto>("reorder_pages", { newOrder });
  },

  async rotatePages(pages: number[], deltaDeg: number): Promise<DocumentDto> {
    return callIpc<DocumentDto>("rotate_pages", { pages, deltaDeg });
  },

  async cropPages(pages: number[], cropBox: PageBox | null, keepPageSize = false, rotationDeg = 0): Promise<DocumentDto> {
    return callIpc<DocumentDto>("crop_pages", { pages, cropBox, keepPageSize, rotationDeg });
  },

  async deletePages(pages: number[]): Promise<DocumentDto> {
    return callIpc<DocumentDto>("delete_pages", { pages });
  },

  async duplicatePages(pages: number[]): Promise<DocumentDto> {
    return callIpc<DocumentDto>("duplicate_pages", { pages });
  },

  async insertBlankPage(atIndex: number, width: number, height: number): Promise<DocumentDto> {
    return callIpc<DocumentDto>("insert_blank_page", { atIndex, width, height });
  },

  async addAnnotation(annotation: AnnotationDto): Promise<DocumentDto> {
    return callIpc<DocumentDto>("add_annotation", { annotation });
  },

  async updateAnnotation(annotation: AnnotationDto): Promise<DocumentDto> {
    return callIpc<DocumentDto>("update_annotation", { annotation });
  },

  async deleteAnnotation(pageIndex: number, annotationId: string): Promise<DocumentDto> {
    return callIpc<DocumentDto>("delete_annotation", { pageIndex, annotationId });
  },

  async addImageAnnotation(
    pageIndex: number,
    rect: PageBox,
    imageBase64: string,
    opacity: number
  ): Promise<DocumentDto> {
    return callIpc<DocumentDto>("add_image_annotation", {
      pageIndex,
      rect,
      imageBase64,
      opacity,
    });
  },

  async coverErase(pageIndex: number, rect: PageBox, color: string): Promise<DocumentDto> {
    return callIpc<DocumentDto>("cover_erase", { pageIndex, rect, color });
  },

  async redactText(pageIndex: number, text: string): Promise<DocumentDto> {
    return callIpc<DocumentDto>("true_redact", { pageIndex, text });
  },

  async applyAreaRedactions(items: AreaRedactItem[]): Promise<DocumentDto> {
    return callIpc<DocumentDto>("apply_area_redactions", { items });
  },

  async updateMetadata(metadata: DocumentMetadataUpdate): Promise<DocumentDto> {
    return callIpc<DocumentDto>("update_metadata", { metadata });
  },

  async stripMetadata(): Promise<DocumentDto> {
    return callIpc<DocumentDto>("strip_metadata");
  },

  async mergePdf(paths: string[], insertAt?: number | null): Promise<DocumentDto> {
    return callIpc<DocumentDto>("merge_pdf", { paths, insertAt: insertAt ?? null });
  },

  async extractPages(pages: number[], targetPath: string): Promise<void> {
    return callIpc<void>("extract_pages", { pages, targetPath });
  },

  async exportPagesAsImages(
    pages: number[],
    outputDir: string,
    format: "png" | "jpeg",
    dpi: number
  ): Promise<string[]> {
    return callIpc<string[]>("export_pages_as_images", {
      pages,
      outputDir,
      format,
      dpi,
    });
  },

  async applyWatermarkOrPageNumbers(options: BatchOverlayOptions): Promise<DocumentDto> {
    return callIpc<DocumentDto>("apply_watermark_or_page_numbers", { options });
  },

  async getDocumentOutline(): Promise<OutlineItem[]> {
    return callIpc<OutlineItem[]>("get_document_outline");
  },

  async updateDocumentOutline(items: OutlineItem[]): Promise<DocumentDto> {
    return callIpc<DocumentDto>("update_document_outline", { items });
  },

  async getPageTextSpans(pageIndex: number): Promise<TextSpanDto[]> {
    return callIpc<TextSpanDto[]>("get_page_text_spans", { pageIndex });
  },

  async getPageLinks(pageIndex: number): Promise<LinkDto[]> {
    return callIpc<LinkDto[]>("get_page_links", { pageIndex });
  },

  async getFormFields(): Promise<FormFieldDto[]> {
    return callIpc<FormFieldDto[]>("get_form_fields");
  },

  async setFormFieldValue(fieldId: string, value: string): Promise<DocumentDto> {
    return callIpc<DocumentDto>("set_form_field_value", { fieldId, value });
  },

  async flattenFormFields(): Promise<DocumentDto> {
    return callIpc<DocumentDto>("flatten_form_fields");
  },

  async detectCropMargins(pageIndex: number): Promise<PageBox> {
    return callIpc<PageBox>("detect_crop_margins", { pageIndex });
  },

  async undo(): Promise<DocumentDto> {
    return callIpc<DocumentDto>("undo");
  },

  async redo(): Promise<DocumentDto> {
    return callIpc<DocumentDto>("redo");
  },

  async saveDocument(makeBackup: boolean): Promise<void> {
    return callIpc<void>("save_document", { makeBackup });
  },

  async saveDocumentAs(targetPath: string, makeBackup: boolean): Promise<void> {
    return callIpc<void>("save_document_as", { targetPath, makeBackup });
  },

  async evaluateRange(expression: string, totalPages: number): Promise<number[]> {
    return callIpc<number[]>("evaluate_range", { expression, totalPages });
  },

  async searchDocument(query: string, caseSensitive: boolean, isRegex = false): Promise<SearchResult[]> {
    return callIpc<SearchResult[]>("search_document", { query, caseSensitive, isRegex });
  },

  async getDocumentState(): Promise<DocumentDto> {
    return callIpc<DocumentDto>("get_document_state");
  },

  async revealInFolder(path: string): Promise<void> {
    return callIpc<void>("reveal_in_folder", { path });
  },

  async renameDocument(newName: string): Promise<DocumentDto> {
    return callIpc<DocumentDto>("rename_document", { newName });
  },

  async openExternalUrl(url: string): Promise<void> {
    if (isTauri()) {
      return callIpc<void>("open_external_url", { url });
    }
    window.open(url, "_blank", "noopener,noreferrer");
  },

  async consumeLaunchFile(): Promise<string | null> {
    if (!isTauri()) return null;
    return callIpc<string | null>("consume_launch_file");
  },

  async readImageDataUrl(path: string): Promise<string> {
    return callIpc<string>("read_image_data_url", { path });
  },

  async snapshotRecoveryState(): Promise<boolean> {
    if (!isTauri()) return false;
    return callIpc<boolean>("snapshot_recovery_state");
  },

  async checkRecoveryState(): Promise<{ original_path?: string | null; file_name: string; saved_at_ms: number } | null> {
    if (!isTauri()) return null;
    return callIpc<{ original_path?: string | null; file_name: string; saved_at_ms: number } | null>("check_recovery_state");
  },

  async restoreRecoveryState(): Promise<DocumentDto> {
    return callIpc<DocumentDto>("restore_recovery_state");
  },

  async discardRecoveryState(): Promise<void> {
    if (!isTauri()) return;
    return callIpc<void>("discard_recovery_state");
  },
};
