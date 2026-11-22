import { Backend } from "../ipc/backend";
import { CropRatioMode, DocumentDto, PageBox, ToolSettings, ToolType, ViewMode } from "../types/editor";

export type Listener = () => void;

class EditorState {
  doc: DocumentDto | null = null;
  activeTool: ToolType = "select";
  viewMode: ViewMode = "continuous";
  zoom: number = 1.0; // 100%
  currentPage: number = 0;
  selectedPages: Set<number> = new Set();
  selectedAnnotationId: string | null = null;
  theme: "light" | "dark" = "light";
  recentFiles: string[] = [];
  cropBox: PageBox | null = null;

  toolSettings: ToolSettings = {
    strokeColor: "#2563eb",
    fillColor: null,
    strokeWidth: 2,
    opacity: 1.0,
    fontSize: 14,
    fontFamily: "Helvetica, Arial, sans-serif",
    author: "User",
    stampText: "APPROVED",
    coverColor: "#ffffff",
    units: "pt",
    cropRatioMode: "free",
  };

  private listeners: Set<Listener> = new Set();

  constructor() {
    this.loadPersistedSettings();
  }

  private loadPersistedSettings() {
    try {
      const savedTheme = localStorage.getItem("pdf_editor_theme");
      if (savedTheme === "dark" || savedTheme === "light") {
        this.theme = savedTheme;
        document.documentElement.setAttribute("data-theme", savedTheme);
      }
      const savedRecent = localStorage.getItem("pdf_editor_recent_files");
      if (savedRecent) {
        this.recentFiles = JSON.parse(savedRecent);
      }
      const savedSettings = localStorage.getItem("pdf_editor_tool_settings");
      if (savedSettings) {
        this.toolSettings = { ...this.toolSettings, ...JSON.parse(savedSettings) };
      }
    } catch {
      // Storage access gracefully handled
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify() {
    for (const listener of this.listeners) {
      listener();
    }
  }

  setDocument(doc: DocumentDto | null) {
    this.doc = doc;
    this.selectedPages.clear();
    this.selectedAnnotationId = null;
    this.currentPage = 0;
    this.cropBox = null;

    if (doc?.file_path) {
      this.addRecentFile(doc.file_path);
    }
    this.notify();
  }

  addRecentFile(path: string) {
    this.recentFiles = [path, ...this.recentFiles.filter((p) => p !== path)].slice(0, 8);
    try {
      localStorage.setItem("pdf_editor_recent_files", JSON.stringify(this.recentFiles));
    } catch {
      // Graceful storage fallback
    }
    this.notify();
  }

  initCropBoxForCurrentPage() {
    if (!this.doc) return;
    const page = this.doc.pages[this.currentPage];
    if (page) {
      this.cropBox = page.crop_box ?? {
        x: Math.round(page.width * 0.08),
        y: Math.round(page.height * 0.08),
        width: Math.round(page.width * 0.84),
        height: Math.round(page.height * 0.84),
      };
    }
  }

  setCropBox(box: PageBox | null) {
    this.cropBox = box;
    this.notify();
  }

  setCropRatioMode(mode: CropRatioMode) {
    this.toolSettings.cropRatioMode = mode;
    this.notify();
  }

  setTool(tool: ToolType) {
    this.activeTool = tool;
    if (tool === "crop" && this.doc) {
      this.initCropBoxForCurrentPage();
    }
    this.notify();
  }

  setViewMode(mode: ViewMode) {
    this.viewMode = mode;
    this.notify();
  }

  setZoom(zoom: number) {
    this.zoom = Math.min(8.0, Math.max(0.1, zoom));
    this.notify();
  }

  zoomIn() {
    this.setZoom(this.zoom * 1.2);
  }

  zoomOut() {
    this.setZoom(this.zoom / 1.2);
  }

  setCurrentPage(page: number) {
    if (this.doc && page >= 0 && page < this.doc.page_count) {
      this.currentPage = page;
      if (this.activeTool === "crop") {
        this.initCropBoxForCurrentPage();
      }
      this.notify();
    }
  }

  togglePageSelection(pageIndex: number, multi = false) {
    if (!multi) {
      if (this.selectedPages.has(pageIndex) && this.selectedPages.size === 1) {
        this.selectedPages.clear();
      } else {
        this.selectedPages.clear();
        this.selectedPages.add(pageIndex);
      }
    } else {
      if (this.selectedPages.has(pageIndex)) {
        this.selectedPages.delete(pageIndex);
      } else {
        this.selectedPages.add(pageIndex);
      }
    }
    this.currentPage = pageIndex;
    this.notify();
  }

  selectPageRange(indices: number[]) {
    this.selectedPages.clear();
    for (const idx of indices) {
      this.selectedPages.add(idx);
    }
    if (indices.length > 0) {
      this.currentPage = indices[0];
    }
    this.notify();
  }

  selectAllPages() {
    if (!this.doc) return;
    this.selectedPages.clear();
    for (let i = 0; i < this.doc.page_count; i++) {
      this.selectedPages.add(i);
    }
    this.notify();
  }

  invertPageSelection() {
    if (!this.doc) return;
    const inverted = new Set<number>();
    for (let i = 0; i < this.doc.page_count; i++) {
      if (!this.selectedPages.has(i)) {
        inverted.add(i);
      }
    }
    this.selectedPages = inverted;
    this.notify();
  }

  setTheme(theme: "light" | "dark") {
    this.theme = theme;
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("pdf_editor_theme", theme);
    } catch {
      // Storage fallback
    }
    this.notify();
  }

  toggleTheme() {
    this.setTheme(this.theme === "light" ? "dark" : "light");
  }

  updateToolSettings(settings: Partial<ToolSettings>) {
    this.toolSettings = { ...this.toolSettings, ...settings };
    try {
      localStorage.setItem("pdf_editor_tool_settings", JSON.stringify(this.toolSettings));
    } catch {
      // Storage fallback
    }
    this.notify();
  }

  async undo() {
    if (!this.doc?.can_undo) return;
    try {
      const updated = await Backend.undo();
      this.setDocument(updated);
    } catch (err) {
      console.error("Undo failed:", err);
    }
  }

  async redo() {
    if (!this.doc?.can_redo) return;
    try {
      const updated = await Backend.redo();
      this.setDocument(updated);
    } catch (err) {
      console.error("Redo failed:", err);
    }
  }
}

export const editorState = new EditorState();
