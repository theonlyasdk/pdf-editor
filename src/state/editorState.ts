import { Backend } from "../ipc/backend";
import {
  AreaRedactItem,
  CropRatioMode,
  DocumentDto,
  EditorPreferences,
  PageBox,
  SidebarTab,
  ThemeMode,
  ToolSettings,
  ToolType,
  ViewMode,
  ZoomFitMode,
} from "../types/editor";

export type Listener = () => void;

export const DEFAULT_PREFERENCES: EditorPreferences = {
  themeMode: "system",
  defaultViewMode: "continuous",
  defaultZoom: "100%",
  units: "pt",
  author: "User",
  makeBackup: true,
  autosaveIntervalSec: 0,
};

function resolveEffectiveTheme(mode: ThemeMode): "light" | "dark" {
  if (mode === "light" || mode === "dark") return mode;
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  if (typeof document !== "undefined" && document.documentElement.dataset.theme === "dark") {
    return "dark";
  }
  return "light";
}

class EditorState {
  doc: DocumentDto | null = null;
  activeTool: ToolType = "select";
  viewMode: ViewMode = "continuous";
  zoom: number = 1.0; // 100%
  zoomFitMode: ZoomFitMode = "custom";
  currentPage: number = 0;
  selectedPages: Set<number> = new Set();
  selectedAnnotationId: string | null = null;
  activeSidebarTab: SidebarTab = "thumbnails";
  pendingRedactions: AreaRedactItem[] = [];
  theme: "light" | "dark" =
    typeof document !== "undefined" && document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  recentFiles: string[] = [];
  cropBox: PageBox | null = null;
  openingFile: string | null = null;
  documentVersion = 0;
  rasterVersion = 0;

  preferences: EditorPreferences = { ...DEFAULT_PREFERENCES };

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
    this.bindSystemThemeListener();
  }

  private bindSystemThemeListener() {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (this.preferences.themeMode === "system") {
        const next = mq.matches ? "dark" : "light";
        if (this.theme !== next) {
          this.theme = next;
          if (typeof document !== "undefined") {
            document.documentElement.setAttribute("data-theme", next);
          }
          this.notify();
        }
      }
    };
    mq.addEventListener?.("change", onChange);
  }

  private loadPersistedSettings() {
    try {
      const savedRecent = localStorage.getItem("pdf_editor_recent_files");
      if (savedRecent) {
        this.recentFiles = JSON.parse(savedRecent);
      }
      const savedSettings = localStorage.getItem("pdf_editor_tool_settings");
      if (savedSettings) {
        this.toolSettings = { ...this.toolSettings, ...JSON.parse(savedSettings) };
      }
      const savedPrefs = localStorage.getItem("pdf_editor_preferences");
      if (savedPrefs) {
        this.preferences = { ...DEFAULT_PREFERENCES, ...JSON.parse(savedPrefs) };
      } else {
        const savedTheme = localStorage.getItem("pdf_editor_theme");
        if (savedTheme === "light" || savedTheme === "dark" || savedTheme === "system") {
          this.preferences.themeMode = savedTheme;
        }
        this.preferences.units = this.toolSettings.units;
        this.preferences.author = this.toolSettings.author;
      }
      this.toolSettings.units = this.preferences.units;
      this.toolSettings.author = this.preferences.author;
      this.viewMode = this.preferences.defaultViewMode;
      this.applyDefaultZoom();
      this.theme = resolveEffectiveTheme(this.preferences.themeMode);
      if (typeof document !== "undefined") {
        document.documentElement.setAttribute("data-theme", this.theme);
      }
    } catch {
      // Storage access gracefully handled
    }
  }

  private applyDefaultZoom() {
    if (this.preferences.defaultZoom === "fit-width") {
      this.zoomFitMode = "fit-width";
    } else if (this.preferences.defaultZoom === "fit-page") {
      this.zoomFitMode = "fit-page";
    } else {
      this.zoomFitMode = "custom";
      this.zoom = 1.0;
    }
  }

  private persistPreferences() {
    try {
      localStorage.setItem("pdf_editor_preferences", JSON.stringify(this.preferences));
      localStorage.setItem("pdf_editor_theme", this.preferences.themeMode);
      localStorage.setItem("pdf_editor_tool_settings", JSON.stringify(this.toolSettings));
    } catch {
      // Storage fallback
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

  setOpeningFile(name: string | null) {
    this.openingFile = name;
    this.notify();
  }

  setDocument(doc: DocumentDto | null) {
    this.documentVersion++;
    this.rasterVersion++;
    this.doc = doc;
    this.selectedPages.clear();
    this.selectedAnnotationId = null;
    this.pendingRedactions = [];
    this.currentPage = 0;
    this.cropBox = null;
    if (doc) {
      this.viewMode = this.preferences.defaultViewMode;
      this.applyDefaultZoom();
    }
    if (this.activeTool === "crop") this.initCropBoxForCurrentPage();

    if (doc?.file_path) {
      this.addRecentFile(doc.file_path);
    } else {
      this.notify();
    }
  }

  updateDocument(doc: DocumentDto) {
    this.rasterVersion++;
    this.doc = doc;
    if (!doc.annotations?.some(({ id }) => id === this.selectedAnnotationId)) this.selectedAnnotationId = null;
    this.currentPage = Math.max(0, Math.min(this.currentPage, doc.page_count - 1));
    for (const page of this.selectedPages) {
      if (page >= doc.page_count) this.selectedPages.delete(page);
    }
    if (this.activeTool === "crop") this.initCropBoxForCurrentPage();
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
      this.cropBox = { x: 0, y: 0, width: page.width, height: page.height };
    }
  }

  setCropBox(box: PageBox | null) {
    const page = this.doc?.pages[this.currentPage];
    if (box && page) {
      const x = Math.max(0, Math.min(page.width - 1, box.x));
      const y = Math.max(0, Math.min(page.height - 1, box.y));
      box = {
        x, y,
        width: Math.max(1, Math.min(page.width - x, box.width)),
        height: Math.max(1, Math.min(page.height - y, box.height)),
      };
    }
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

  clearRecentFiles() {
    this.recentFiles = [];
    try {
      localStorage.removeItem("pdf_editor_recent_files");
    } catch {
      // Storage fallback
    }
    this.notify();
  }

  setSidebarTab(tab: SidebarTab) {
    if (this.activeSidebarTab === tab) return;
    this.activeSidebarTab = tab;
    this.notify();
  }

  addPendingRedaction(item: AreaRedactItem) {
    this.pendingRedactions = [...this.pendingRedactions, item];
    this.notify();
  }

  removePendingRedaction(index: number) {
    this.pendingRedactions = this.pendingRedactions.filter((_, i) => i !== index);
    this.notify();
  }

  clearPendingRedactions() {
    if (this.pendingRedactions.length === 0) return;
    this.pendingRedactions = [];
    this.notify();
  }

  setZoom(zoom: number, keepFitMode = false) {
    this.zoom = Math.min(8.0, Math.max(0.1, zoom));
    if (!keepFitMode) {
      this.zoomFitMode = "custom";
    }
    this.notify();
  }

  requestFitWidth() {
    this.zoomFitMode = "fit-width";
    this.notify();
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("zoom-fit-width"));
    }
  }

  requestFitPage() {
    this.zoomFitMode = "fit-page";
    this.notify();
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("zoom-fit-page"));
    }
  }

  zoomIn() {
    this.setZoom(this.zoom * 1.2);
  }

  zoomOut() {
    this.setZoom(this.zoom / 1.2);
  }

  selectAnnotation(id: string | null) {
    if (this.selectedAnnotationId === id) return;
    this.selectedAnnotationId = id;
    this.notify();
  }

  setCurrentPage(page: number) {
    if (this.doc && page >= 0 && page < this.doc.page_count) {
      if (this.currentPage === page) return;
      this.currentPage = page;
      this.selectedAnnotationId = null;
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
    this.preferences.themeMode = theme;
    if (typeof document !== "undefined") {
      document.documentElement.setAttribute("data-theme", theme);
    }
    this.persistPreferences();
    this.notify();
  }

  setThemeMode(mode: ThemeMode) {
    this.preferences.themeMode = mode;
    this.theme = resolveEffectiveTheme(mode);
    if (typeof document !== "undefined") {
      document.documentElement.setAttribute("data-theme", this.theme);
    }
    this.persistPreferences();
    this.notify();
  }

  toggleTheme() {
    this.setTheme(this.theme === "light" ? "dark" : "light");
  }

  updatePreferences(partial: Partial<EditorPreferences>) {
    this.preferences = { ...this.preferences, ...partial };
    if (partial.themeMode !== undefined) {
      this.theme = resolveEffectiveTheme(this.preferences.themeMode);
      if (typeof document !== "undefined") {
        document.documentElement.setAttribute("data-theme", this.theme);
      }
    }
    if (partial.units !== undefined) {
      this.toolSettings = { ...this.toolSettings, units: partial.units };
    }
    if (partial.author !== undefined) {
      this.toolSettings = { ...this.toolSettings, author: partial.author };
    }
    this.persistPreferences();
    this.notify();
  }

  resetPreferences() {
    this.preferences = { ...DEFAULT_PREFERENCES };
    this.toolSettings = {
      ...this.toolSettings,
      units: DEFAULT_PREFERENCES.units,
      author: DEFAULT_PREFERENCES.author,
    };
    this.theme = resolveEffectiveTheme(this.preferences.themeMode);
    if (typeof document !== "undefined") {
      document.documentElement.setAttribute("data-theme", this.theme);
    }
    this.persistPreferences();
    this.notify();
  }

  updateToolSettings(settings: Partial<ToolSettings>, render = true) {
    this.toolSettings = { ...this.toolSettings, ...settings };
    if (settings.units !== undefined) {
      this.preferences.units = settings.units;
    }
    if (settings.author !== undefined) {
      this.preferences.author = settings.author;
    }
    this.persistPreferences();
    if (render) this.notify();
  }

  async undo() {
    if (!this.doc?.can_undo) return;
    try {
      const updated = await Backend.undo();
      this.updateDocument(updated);
    } catch (err) {
      console.error("Undo failed:", err);
    }
  }

  async redo() {
    if (!this.doc?.can_redo) return;
    try {
      const updated = await Backend.redo();
      this.updateDocument(updated);
    } catch (err) {
      console.error("Redo failed:", err);
    }
  }
}

export const editorState = new EditorState();
