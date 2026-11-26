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
import {
  handleDroppedImagePath,
  initImagePasteHandler,
  isSupportedImageFile,
  isSupportedImagePath,
  placeImageOnPageAtClientPoint,
} from "./components/imageDropPaste";
import { rasterizeImageBlob } from "./components/SignatureModal";
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
          if (editorState.doc && isSupportedImagePath(paths[0])) {
            await handleDroppedImagePath(paths[0], payload.position?.x, payload.position?.y);
          } else {
            await guardedOpenPdf(paths[0]);
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
        const file: File = e.dataTransfer.files[0];
        if (editorState.doc && isSupportedImageFile(file)) {
          try {
            const { dataUrl, width, height } = await rasterizeImageBlob(file, 1200);
            await placeImageOnPageAtClientPoint(dataUrl, width, height, e.clientX, e.clientY, file.name);
          } catch (err) {
            toast.show({ message: `Could not add image: ${String(err)}`, type: "error" });
          }
          return;
        }
        await guardedOpenPdf((file as any).path || file.name);
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
  const curLabel = doc.pages[editorState.currentPage]?.label || String(cur);

  const form = document.createElement("form");
  form.className = "status-page-jump-form";
  form.innerHTML = `
    <label class="sr-only" for="status-page-jump-input">Jump to page</label>
    <span>Page</span>
    <input
      id="status-page-jump-input"
      type="text"
      class="status-page-jump-input"
      value="${curLabel.replace(/"/g, "&quot;")}"
      aria-label="Jump to page number or label"
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
      const raw = input.value.trim();
      if (raw) {
        const exactIdx = doc.pages.findIndex((p) => p.label === raw);
        const ciIdx = exactIdx >= 0 ? exactIdx : doc.pages.findIndex((p) => p.label?.toLowerCase() === raw.toLowerCase());
        if (ciIdx >= 0) {
          jumpToPage(ciIdx);
        } else {
          const parsed = Math.floor(Number(raw));
          if (Number.isFinite(parsed) && parsed >= 1 && parsed <= total) {
            jumpToPage(parsed - 1);
          }
        }
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

let activeZoomPopover: {
  root: HTMLElement;
  slider: HTMLInputElement;
  valueBtn: HTMLButtonElement;
  isEditingInput: () => boolean;
  close: () => void;
} | null = null;

function openZoomPopover(anchor: HTMLElement) {
  if (activeZoomPopover) {
    activeZoomPopover.close();
    return;
  }

  const popover = document.createElement("div");
  popover.className = "zoom-popover";
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", "Zoom level");

  const pct = Math.round(editorState.zoom * 100);
  popover.innerHTML = `
    <div class="zoom-popover-row">
      <input type="range" class="ui-slider zoom-popover-slider" min="10" max="800" step="1" value="${pct}" aria-label="Zoom percentage" />
      <button type="button" class="zoom-popover-value" title="Click to enter custom zoom">${pct}%</button>
    </div>
  `;

  document.body.appendChild(popover);

  const slider = popover.querySelector<HTMLInputElement>(".zoom-popover-slider")!;
  const valueBtn = popover.querySelector<HTMLButtonElement>(".zoom-popover-value")!;
  let editing = false;

  const rect = anchor.getBoundingClientRect();
  const popW = popover.offsetWidth || 220;
  const popH = popover.offsetHeight || 42;
  popover.style.left = `${Math.max(8, Math.min(rect.right - popW, window.innerWidth - popW - 8))}px`;
  popover.style.top = `${Math.max(8, rect.top - popH - 6)}px`;

  const abort = new AbortController();
  const close = () => {
    abort.abort();
    popover.remove();
    activeZoomPopover = null;
  };

  activeZoomPopover = {
    root: popover,
    slider,
    valueBtn,
    isEditingInput: () => editing,
    close,
  };

  slider.addEventListener("input", () => {
    const val = Number(slider.value);
    if (Number.isFinite(val)) {
      editorState.setZoom(val / 100);
    }
  });

  valueBtn.addEventListener("click", () => {
    if (editing) return;
    editing = true;
    const input = document.createElement("input");
    input.type = "text";
    input.inputMode = "numeric";
    input.className = "zoom-popover-input";
    input.value = String(Math.round(editorState.zoom * 100));
    input.setAttribute("aria-label", "Custom zoom percentage");
    valueBtn.replaceWith(input);
    input.focus();
    input.select();

    const finish = (commit: boolean) => {
      if (!editing) return;
      editing = false;
      if (commit) {
        const raw = input.value.replace("%", "").trim();
        const parsed = Number(raw);
        if (Number.isFinite(parsed) && parsed > 0) {
          const clamped = Math.min(800, Math.max(10, Math.round(parsed)));
          editorState.setZoom(clamped / 100);
        }
      }
      valueBtn.textContent = `${Math.round(editorState.zoom * 100)}%`;
      input.replaceWith(valueBtn);
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
  });

  window.addEventListener(
    "pointerdown",
    (e) => {
      const target = e.target as Node;
      if (!popover.contains(target) && !anchor.contains(target)) {
        close();
      }
    },
    { capture: true, signal: abort.signal }
  );

  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && !editing) {
        e.preventDefault();
        close();
      }
    },
    { signal: abort.signal }
  );
}

function setupStatusBarZoomControls() {
  const zoomOutBtn = document.getElementById("btn-zoom-out") as HTMLButtonElement | null;
  const zoomInBtn = document.getElementById("btn-zoom-in") as HTMLButtonElement | null;
  const zoomInfoBtn = document.getElementById("status-zoom-info") as HTMLButtonElement | null;
  if (zoomOutBtn) {
    zoomOutBtn.innerHTML = icon(ZoomOut);
    zoomOutBtn.title = STRINGS.viewModes.zoomOut;
    zoomOutBtn.setAttribute("aria-label", STRINGS.viewModes.zoomOut);
    zoomOutBtn.addEventListener("click", () => editorState.zoomOut());
  }
  if (zoomInfoBtn) {
    zoomInfoBtn.addEventListener("click", () => {
      if (!editorState.doc) return;
      openZoomPopover(zoomInfoBtn);
    });
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
    activeZoomPopover?.close();
    if (pageInfoSpan) pageInfoSpan.textContent = "Ready";
    if (zoomControls) zoomControls.hidden = true;
    if (zoomInfoSpan) zoomInfoSpan.textContent = "";
    return;
  }

  if (zoomControls) zoomControls.hidden = false;
  const zoomPct = Math.round(editorState.zoom * 100);
  if (zoomInfoSpan) {
    zoomInfoSpan.textContent = `${zoomPct}%`;
  }
  if (activeZoomPopover) {
    activeZoomPopover.slider.value = String(zoomPct);
    if (!activeZoomPopover.isEditingInput()) {
      activeZoomPopover.valueBtn.textContent = `${zoomPct}%`;
    }
  }
  if (zoomOutBtn) zoomOutBtn.disabled = editorState.zoom <= 0.1001;
  if (zoomInBtn) zoomInBtn.disabled = editorState.zoom >= 7.9999;

  if (isEditingPageJump || !pageInfoSpan) return;

  const cur = editorState.currentPage + 1;
  const total = editorState.doc.page_count;
  const sel = editorState.selectedPages.size;
  const curLabel = editorState.doc.pages[editorState.currentPage]?.label;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "status-page-btn";
  btn.id = "status-page-jump-btn";
  btn.title = "Click to jump to page (Ctrl+G)";
  btn.textContent = curLabel && curLabel !== String(cur)
    ? `Page ${curLabel} (${cur} of ${total})`
    : `Page ${cur} of ${total}`;
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

function setupCrashRecovery() {
  if (!isTauri()) return;
  let snapshotting = false;
  window.setInterval(async () => {
    if (snapshotting || editorState.openingFile) return;
    const doc = editorState.doc;
    if (!doc || !doc.is_dirty) return;
    snapshotting = true;
    try {
      await Backend.snapshotRecoveryState();
    } catch (err) {
      console.warn("Recovery snapshot failed:", err);
    } finally {
      snapshotting = false;
    }
  }, 15_000);
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

  (window as any).__EDITOR_STATE__ = editorState;
  (window as any).__OPEN_PDF__ = openPdf;
  (window as any).__BACKEND__ = Backend;

  const loading = document.getElementById("document-loading")!;
  const shell = document.getElementById("app-root")!;
  editorState.subscribe(() => {
    const file = editorState.openingFile;
    loading.hidden = !file;
    shell.inert = Boolean(file);
    loading.querySelector("p")!.textContent = file ? `Opening ${file}…` : "";
  });

  window.addEventListener("open-page-jump", openStatusPageJump);
  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "b" && editorState.doc && !editorState.openingFile) {
      e.preventDefault();
      editorState.setSidebarTab("outline");
      window.dispatchEvent(new CustomEvent("add-bookmark-current-page"));
    }
  });
  setupWindowDragDrop();
  initImagePasteHandler();
  initWindowCloseGuard();
  setupAutosave();
  setupCrashRecovery();
  setupStatusBarZoomControls();

  editorState.subscribe(updateStatusBar);
  updateStatusBar();
  void revealWindow().catch(console.error);

  if (isTauri()) {
    void (async () => {
      const recovery = await Backend.checkRecoveryState().catch(() => null);
      if (recovery) {
        try {
          const { ask } = await import("@tauri-apps/plugin-dialog");
          const shouldRestore = await ask(
            `Unsaved changes from a previous session were found for "${recovery.file_name}". Would you like to recover them?`,
            { title: "Recover Unsaved Session", kind: "warning" }
          );
          if (shouldRestore) {
            editorState.setDocument(await Backend.restoreRecoveryState());
            toast.show({ message: `Recovered unsaved changes for ${recovery.file_name}.`, type: "success" });
            return;
          }
          await Backend.discardRecoveryState();
        } catch (err) {
          console.warn("Crash recovery check failed:", err);
        }
      }
      const launchPath = await Backend.consumeLaunchFile().catch(() => null);
      if (launchPath) {
        await openPdf(launchPath);
        return;
      }
      if (
        editorState.preferences.reopenLastPdf &&
        !editorState.doc &&
        editorState.recentFiles.length > 0
      ) {
        await openPdf(editorState.recentFiles[0]);
      }
    })();
  }
});
