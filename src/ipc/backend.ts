import { AnnotationDto, DocumentDto, PageBox, SearchResult } from "../types/editor";

// Check if running inside Tauri runtime
const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function callIpc<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(cmd, args);
  }
  throw new Error(`Tauri IPC not available for '${cmd}' outside desktop app`);
}

export const Backend = {
  async openDocument(path: string, password?: string): Promise<DocumentDto> {
    return callIpc<DocumentDto>("open_document", { path, password });
  },

  async newDocument(): Promise<DocumentDto> {
    return callIpc<DocumentDto>("new_document");
  },

  async renderPage(pageIndex: number, targetWidth: number): Promise<string> {
    return callIpc<string>("render_page", { pageIndex, targetWidth });
  },

  async reorderPages(newOrder: number[]): Promise<DocumentDto> {
    return callIpc<DocumentDto>("reorder_pages", { newOrder });
  },

  async rotatePages(pages: number[], deltaDeg: number): Promise<DocumentDto> {
    return callIpc<DocumentDto>("rotate_pages", { pages, deltaDeg });
  },

  async cropPages(pages: number[], cropBox: PageBox | null): Promise<DocumentDto> {
    return callIpc<DocumentDto>("crop_pages", { pages, cropBox });
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

  async deleteAnnotation(pageIndex: number, annotationId: string): Promise<DocumentDto> {
    return callIpc<DocumentDto>("delete_annotation", { pageIndex, annotationId });
  },

  async coverErase(pageIndex: number, rect: PageBox, color: string): Promise<DocumentDto> {
    return callIpc<DocumentDto>("cover_erase", { pageIndex, rect, color });
  },

  async trueRedact(pageIndex: number, rect: PageBox, text?: string): Promise<DocumentDto> {
    return callIpc<DocumentDto>("true_redact", { pageIndex, rect, text });
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

  async searchDocument(query: string, caseSensitive: boolean): Promise<SearchResult[]> {
    return callIpc<SearchResult[]>("search_document", { query, caseSensitive });
  },

  async getDocumentState(): Promise<DocumentDto> {
    return callIpc<DocumentDto>("get_document_state");
  },
};
