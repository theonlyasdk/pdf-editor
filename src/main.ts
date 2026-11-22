import { DocumentSearchView } from "./components/DocumentSearch";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { CanvasViewportView } from "./components/CanvasView";
import { CommandPaletteView } from "./components/CommandPalette";
import { EmptyStateView } from "./components/EmptyState";
import { PropertiesPanelView } from "./components/PropertiesPanel";
import { ThumbnailRailView } from "./components/ThumbnailRail";
import { toast } from "./components/Toast";
import { ToolbarView } from "./components/Toolbar";
import { openPdf } from "./components/OpenPdf";
import { editorState } from "./state/editorState";

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
          await openPdf(paths[0]);
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
        await openPdf(file.path || file.name);
      }
    });
  }
}

function updateStatusBar() {
  const pageInfoSpan = document.getElementById("status-page-info");
  const zoomInfoSpan = document.getElementById("status-zoom-info");

  if (!editorState.doc) {
    if (pageInfoSpan) pageInfoSpan.textContent = "Ready";
    if (zoomInfoSpan) zoomInfoSpan.textContent = "";
    return;
  }

  const cur = editorState.currentPage + 1;
  const total = editorState.doc.page_count;
  const sel = editorState.selectedPages.size;

  if (pageInfoSpan) {
    pageInfoSpan.textContent = `Page ${cur} of ${total}${sel > 0 ? ` (${sel} selected)` : ""}`;
  }
  if (zoomInfoSpan) {
    zoomInfoSpan.textContent = `${Math.round(editorState.zoom * 100)}%`;
  }
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

  const headerEl = document.getElementById("app-header")!;
  const toolbarEl = document.getElementById("action-toolbar")!;
  const railEl = document.getElementById("thumbnail-rail")!;
  const viewportEl = document.getElementById("canvas-viewport")!;
  const propertiesEl = document.getElementById("properties-panel")!;
  const emptyStateEl = document.getElementById("empty-state-container")!;

  new ToolbarView(headerEl, toolbarEl);
  new ThumbnailRailView(railEl);
  new CanvasViewportView(viewportEl);
  new PropertiesPanelView(propertiesEl);
  new EmptyStateView(emptyStateEl);
  new CommandPaletteView();
  new DocumentSearchView();

  const loading = document.getElementById("document-loading")!;
  const shell = document.getElementById("app-root")!;
  editorState.subscribe(() => {
    const file = editorState.openingFile;
    loading.hidden = !file;
    shell.inert = Boolean(file);
    loading.querySelector("p")!.textContent = file ? `Opening ${file}?` : "";
  });

  setupWindowDragDrop();

  editorState.subscribe(updateStatusBar);
  updateStatusBar();
  void revealWindow().catch(console.error);
});
