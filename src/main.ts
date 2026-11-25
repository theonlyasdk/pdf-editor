/// <reference types="vite/client" />
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ZoomIn, ZoomOut } from "lucide";
import { AboutModalView } from "./components/AboutModal";
import { CanvasViewportView } from "./components/CanvasView";
import { CommandPaletteView } from "./components/CommandPalette";
import { DocumentSearchView } from "./components/DocumentSearch";
import { jumpToPage } from "./components/EditorContextMenu";
import { EmptyStateView } from "./components/EmptyState";
import { PreferencesModalView } from "./components/PreferencesModal";
import { PropertiesPanelView } from "./components/PropertiesPanel";
import { ShortcutsModalView } from "./components/ShortcutsModal";
import { SidebarTabsView } from "./components/SidebarTabs";
import { toast } from "./components/Toast";
import { ToolbarView } from "./components/Toolbar";
import { guardedOpenPdf, initWindowCloseGuard } from "./components/UnsavedGuard";
import { openPdf } from "./components/OpenPdf";
import { initCustomSelects } from "./components/ui/Select";
import { icon } from "./components/ui/icon";
import { STRINGS } from "./i18n/strings";
import { Backend } from "./ipc/backend";
import { editorState } from "./state/editorState";

const externalModalModules = import.meta.glob<Record<string, unknown>>(
  [
    "./components/MetadataModal.ts",
    "./components/MergeSplitModal.ts",
    "./components/ExportPrintModal.ts",
    "./components/InsertPageModal.ts",
    "./components/WatermarkModal.ts",
    "./components/SignatureModal.ts",
  ],
  { eager: true }
);

function initExternalModals() {
  const called = new Set<Function>();
  for (const mod of Object.values(externalModalModules)) {
    for (const key of ["initDocToolModals", "initSignatureModal"] as const) {
      const fn = mod[key];
      if (typeof fn === "function" && !called.has(fn)) {
        called.add(fn);
        fn();
      }
    }
  }
}

async function setupWindowDragDrop() {
  try {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    const webview = getCurrentWebview();

    await webview.onDragDropEvent(async (event) => {
      const payload = event.payload;
      if (payload.type === "enter" || payload.type === "over") {
        document.body.classList.add("window-drag-over");
      } else if (payload.type === "leave") {
        document.body.classList.remove("window-drag-over");
      } else if (payload.type === "drop") {
        document.body.classList.remove("window-drag-over");
        const paths = payload.paths;
        if (paths && paths.length > 0) {
          await guardedOpenPdf(paths[0]);
        }
      }
    });
  } catch {
    // DOM Drag and drop fallback
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("drop", async (e: any) => {
      e.preventDefault();
      if (e.dataTransfer?.files?.length) {
        const file = e.dataTransfer.files[0];
        await guardedOpenPdf(file.path || file.name);
      }
    });
  }
}

let isEditingPageJump = false;

function openStatusPageJump() {
  const doc = editorState.doc;
  const pageInfoSpan = document.getElementById("status-page-info");
  if (!doc || !pageInfoSpan || isEditingPageJump) return;

  isEditingPageJump = true;
  const cur = editorState.currentPage + 1;
  const total = doc.page_count;

  const form = document.createElement("form");
  form.className = "status-page-jump-form";
  form.innerHTML = `
    <label class="sr-only" for="status-page-jump-input">Jump to page</label>
    <span>Page</span>
    <input
      id="status-page-jump-input"
      type="number"
      class="status-page-jump-input"
      min="1"
      max="${total}"
      value="${cur}"
      aria-label="Jump to page number"
    />
    <span>of ${total}</span>
  `;

  pageInfoSpan.replaceChildren(form);
  const input = form.querySelector<HTMLInputElement>("#status-page-jump-input")!;
  input.focus();
  input.select();

  let finished = false;
  const exitEdit = (commit: boolean) => {
    if (finished) return;
    finished = true;
    isEditingPageJump = false;
    if (commit) {
      const parsed = Math.floor(Number(input.value));
      if (Number.isFinite(parsed) && parsed >= 1 && parsed <= total) {
        jumpToPage(parsed - 1);
      }
    }
    updateStatusBar();
  };

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    exitEdit(true);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      exitEdit(false);
    }
  });

  input.addEventListener("blur", () => {
    exitEdit(false);
  });
}

function setupStatusBarZoomControls() {
  const zoomOutBtn = document.getElementById("btn-zoom-out") as HTMLButtonElement | null;
  const zoomInBtn = document.getElementById("btn-zoom-in") as HTMLButtonElement | null;
  if (zoomOutBtn) {
    zoomOutBtn.innerHTML = icon(ZoomOut);
    zoomOutBtn.title = STRINGS.viewModes.zoomOut;
    zoomOutBtn.setAttribute("aria-label", STRINGS.viewModes.zoomOut);
    zoomOutBtn.addEventListener("click", () => editorState.zoomOut());
  }
  if (zoomInBtn) {
    zoomInBtn.innerHTML = icon(ZoomIn);
    zoomInBtn.title = STRINGS.viewModes.zoomIn;
    zoomInBtn.setAttribute("aria-label", STRINGS.viewModes.zoomIn);
    zoomInBtn.addEventListener("click", () => editorState.zoomIn());
  }
}

function updateStatusBar() {
  const pageInfoSpan = document.getElementById("status-page-info");
  const zoomControls = document.getElementById("status-zoom-controls");
  const zoomInfoSpan = document.getElementById("status-zoom-info");
  const zoomOutBtn = document.getElementById("btn-zoom-out") as HTMLButtonElement | null;
  const zoomInBtn = document.getElementById("btn-zoom-in") as HTMLButtonElement | null;

  if (!editorState.doc) {
    isEditingPageJump = false;
    if (pageInfoSpan) pageInfoSpan.textContent = "Ready";
    if (zoomControls) zoomControls.hidden = true;
    if (zoomInfoSpan) zoomInfoSpan.textContent = "";
    return;
  }

  if (zoomControls) zoomControls.hidden = false;
  if (zoomInfoSpan) {
    zoomInfoSpan.textContent = `${Math.round(editorState.zoom * 100)}%`;
  }
  if (zoomOutBtn) zoomOutBtn.disabled = editorState.zoom <= 0.1001;
  if (zoomInBtn) zoomInBtn.disabled = editorState.zoom >= 7.9999;

  if (isEditingPageJump || !pageInfoSpan) return;

  const cur = editorState.currentPage + 1;
  const total = editorState.doc.page_count;
  const sel = editorState.selectedPages.size;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "status-page-btn";
  btn.id = "status-page-jump-btn";
  btn.title = "Click to jump to page (Ctrl+G)";
  btn.textContent = `Page ${cur} of ${total}`;
  btn.addEventListener("click", openStatusPageJump);

  if (sel > 0) {
    const selSpan = document.createElement("span");
    selSpan.className = "status-selected-count";
    selSpan.textContent = ` (${sel} selected)`;
    pageInfoSpan.replaceChildren(btn, selSpan);
  } else {
    pageInfoSpan.replaceChildren(btn);
  }
}

function setupAutosave() {
  let currentIntervalSec = editorState.preferences.autosaveIntervalSec;
  let timerId: number | null = null;
  let saving = false;

  const restart = () => {
    if (timerId !== null) {
      window.clearInterval(timerId);
      timerId = null;
    }
    if (currentIntervalSec <= 0) return;

    timerId = window.setInterval(async () => {
      if (saving || editorState.openingFile) return;
      const doc = editorState.doc;
      if (!doc || !doc.is_dirty || !doc.file_path) return;
      saving = true;
      try {
        await Backend.saveDocument(editorState.preferences.makeBackup);
        if (editorState.doc === doc) {
          doc.is_dirty = false;
          editorState.notify();
        }
        toast.show({ message: "Autosaved document.", type: "info", durationMs: 2000 });
      } catch (err) {
        console.warn("Autosave failed:", err);
      } finally {
        saving = false;
      }
    }, currentIntervalSec * 1000);
  };

  restart();
  editorState.subscribe(() => {
    if (editorState.preferences.autosaveIntervalSec !== currentIntervalSec) {
      currentIntervalSec = editorState.preferences.autosaveIntervalSec;
      restart();
    }
  });
}

async function revealWindow() {
  await Promise.allSettled([
    document.fonts.load('600 42px "Lora Variable"'),
    document.fonts.load('600 13px "Manrope Variable"'),
  ]);
  document.documentElement.removeAttribute("data-starting");

  if (isTauri()) {
    const window = getCurrentWindow();
    let appliedTheme: typeof editorState.theme | undefined;
    const syncTheme = async () => {
      if (appliedTheme === editorState.theme) return;
      appliedTheme = editorState.theme;
      await window.setTheme(appliedTheme).catch(console.warn);
    };
    editorState.subscribe(() => void syncTheme());
    await syncTheme();
    await window.show();
  }
}

document.addEventListener("DOMContentLoaded", () => {
  toast.init();
  initCustomSelects();

  const headerEl = document.getElementById("app-header")!;
  const toolbarEl = document.getElementById("action-toolbar")!;
  const railEl = document.getElementById("thumbnail-rail")!;
  const viewportEl = document.getElementById("canvas-viewport")!;
  const propertiesEl = document.getElementById("properties-panel")!;
  const emptyStateEl = document.getElementById("empty-state-container")!;

  new ToolbarView(headerEl, toolbarEl);
  new SidebarTabsView(railEl);
  new CanvasViewportView(viewportEl);
  new PropertiesPanelView(propertiesEl);
  new EmptyStateView(emptyStateEl);
  new CommandPaletteView();
  new DocumentSearchView();
  new PreferencesModalView();
  new ShortcutsModalView();
  new AboutModalView();
  initExternalModals();

  const loading = document.getElementById("document-loading")!;
  const shell = document.getElementById("app-root")!;
  editorState.subscribe(() => {
    const file = editorState.openingFile;
    loading.hidden = !file;
    shell.inert = Boolean(file);
    loading.querySelector("p")!.textContent = file ? `Opening ${file}…` : "";
  });

  window.addEventListener("open-page-jump", openStatusPageJump);
  setupWindowDragDrop();
  initWindowCloseGuard();
  setupAutosave();
  setupStatusBarZoomControls();

  editorState.subscribe(updateStatusBar);
  updateStatusBar();
  void revealWindow().catch(console.error);

  if (
    isTauri() &&
    editorState.preferences.reopenLastPdf &&
    !editorState.doc &&
    editorState.recentFiles.length > 0
  ) {
    void openPdf(editorState.recentFiles[0]);
  }
});
