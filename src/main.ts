import { CanvasViewportView } from "./components/CanvasView";
import { CommandPaletteView } from "./components/CommandPalette";
import { EmptyStateView } from "./components/EmptyState";
import { PropertiesPanelView } from "./components/PropertiesPanel";
import { ThumbnailRailView } from "./components/ThumbnailRail";
import { toast } from "./components/Toast";
import { ToolbarView } from "./components/Toolbar";
import { Backend } from "./ipc/backend";
import { editorState } from "./state/editorState";

async function setupWindowDragDrop() {
  try {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    const webview = getCurrentWebview();

    webview.onDragDropEvent(async (event) => {
      const payload = event.payload;
      if (payload.type === "enter" || payload.type === "over") {
        document.body.classList.add("window-drag-over");
      } else if (payload.type === "leave") {
        document.body.classList.remove("window-drag-over");
      } else if (payload.type === "drop") {
        document.body.classList.remove("window-drag-over");
        const paths = payload.paths;
        if (paths && paths.length > 0) {
          const targetPath = paths[0];
          if (!targetPath.toLowerCase().endsWith(".pdf")) {
            toast.show({
              message: "Unsupported file format. Please drop a valid .pdf file.",
              type: "error",
            });
            return;
          }
          try {
            const doc = await Backend.openDocument(targetPath);
            editorState.setDocument(doc);
            toast.show({
              message: `Opened '${doc.file_name}' (${doc.page_count} pages)`,
              type: "success",
            });
          } catch (err: any) {
            toast.show({ message: `Failed to open PDF: ${err}`, type: "error" });
          }
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
        const path = file.path || file.name;
        if (!path.toLowerCase().endsWith(".pdf")) {
          toast.show({ message: "Please drop a .pdf file.", type: "error" });
          return;
        }
        try {
          const doc = await Backend.openDocument(path);
          editorState.setDocument(doc);
        } catch (err: any) {
          toast.show({ message: err.toString(), type: "error" });
        }
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

  setupWindowDragDrop();

  editorState.subscribe(updateStatusBar);
  updateStatusBar();
});
