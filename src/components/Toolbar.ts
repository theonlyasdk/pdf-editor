import {
  ArrowRight,
  Brush,
  Circle,
  Columns2,
  Command,
  Download,
  Droplets,
  Eraser,
  FileText,
  FolderOpen,
  Grid2X2,
  Hand,
  Highlighter,
  Info,
  Keyboard,
  Maximize2,
  MessageSquare,
  Moon,
  MousePointer2,
  MoveHorizontal,
  PanelsTopLeft,
  PenTool,
  Plus,
  Printer,
  RectangleVertical,
  Redo2,
  RotateCcw,
  RotateCw,
  Save,
  Search,
  Settings,
  ShieldAlert,
  Signature,
  Slash,
  Split,
  Square,
  Stamp,
  Strikethrough,
  Sun,
  Trash2,
  Type,
  Underline,
  Undo2,
  ZoomIn,
  ZoomOut,
  Crop,
} from "lucide";
import { STRINGS } from "../i18n/strings";
import { Backend } from "../ipc/backend";
import { editorState } from "../state/editorState";
import { ToolType, ViewMode } from "../types/editor";
import { showToolMenu } from "./EditorContextMenu";
import { toast } from "./Toast";
import { guardedPickPdf } from "./UnsavedGuard";
import { icon } from "./ui/icon";

export class ToolbarView {
  private headerElement: HTMLElement;
  private actionToolbarElement: HTMLElement;

  constructor(header: HTMLElement, actionToolbar: HTMLElement) {
    this.headerElement = header;
    this.actionToolbarElement = actionToolbar;
    this.actionToolbarElement.addEventListener("contextmenu", (event) => {
      const tool = (event.target as Element).closest<HTMLButtonElement>("[data-tool]")?.dataset.tool;
      if (tool) {
        editorState.setTool(tool as ToolType);
        showToolMenu(event);
      }
    });
    this.render();
    editorState.subscribe(() => this.render());
  }

  render() {
    this.renderHeader();
    this.renderActionToolbar();
  }

  private renderHeader() {
    const isDocOpen = editorState.doc !== null;
    const docTitle = editorState.doc ? editorState.doc.file_name : STRINGS.app.untitled;
    const isDirty = editorState.doc?.is_dirty ?? false;
    const canUndo = editorState.doc?.can_undo ?? false;
    const canRedo = editorState.doc?.can_redo ?? false;
    const fitMode = editorState.zoomFitMode;

    this.headerElement.innerHTML = `
      <div class="header-left">
        <div class="app-brand mr-2">
          ${icon(FileText)}
          <span>${STRINGS.app.title}</span>
        </div>
        <button class="ui-button ui-button--tool" id="btn-open" title="${STRINGS.menu.open} (${STRINGS.menu.openShortcut})">
          ${icon(FolderOpen)}
          <span>Open</span>
        </button>
        <div class="document-controls">
          <button class="ui-button ui-button--tool" id="btn-save" ${!isDocOpen ? "disabled" : ""} title="${STRINGS.menu.save} (${STRINGS.menu.saveShortcut})">
            ${icon(Save)}
            <span>Save</span>
          </button>
          <button class="ui-button ui-button--tool" id="btn-save-as" ${!isDocOpen ? "disabled" : ""} title="${STRINGS.menu.saveAs} (${STRINGS.menu.saveAsShortcut})">
            ${icon(Download)}
            <span>Save As...</span>
          </button>
          <button class="ui-button ui-button--tool" id="btn-export-print" ${!isDocOpen ? "disabled" : ""} title="${STRINGS.menu.exportPrint}">
            ${icon(Printer)}
          </button>
          <button class="ui-button ui-button--tool" id="btn-metadata" ${!isDocOpen ? "disabled" : ""} title="${STRINGS.menu.metadata}">
            ${icon(Info)}
          </button>
          <div class="tool-separator"></div>
          <button class="ui-button ui-button--tool" id="btn-undo" ${!canUndo ? "disabled" : ""} title="Undo (Ctrl+Z)">
            ${icon(Undo2)}
          </button>
          <button class="ui-button ui-button--tool" id="btn-redo" ${!canRedo ? "disabled" : ""} title="Redo (Ctrl+Y)">
            ${icon(Redo2)}
          </button>
        </div>
      </div>

      <div class="header-center">
        ${
          isDocOpen
            ? `<div class="doc-title-badge">
                ${isDirty ? `<span class="dirty-indicator" title="Unsaved changes"></span>` : ""}
                <span class="truncate"></span>
              </div>`
            : ""
        }
      </div>

      <div class="header-right">
        <div class="document-controls">
          <!-- View mode buttons -->
          <div class="ui-button-group mr-1" role="group">
            <button class="ui-button ui-button--tool ${editorState.viewMode === "continuous" ? "active" : ""}" id="view-mode-continuous" title="${STRINGS.viewModes.continuous}">
              ${icon(PanelsTopLeft)}
            </button>
            <button class="ui-button ui-button--tool ${editorState.viewMode === "single" ? "active" : ""}" id="view-mode-single" title="${STRINGS.viewModes.single}">
              ${icon(RectangleVertical)}
            </button>
            <button class="ui-button ui-button--tool ${editorState.viewMode === "spread" ? "active" : ""}" id="view-mode-spread" title="${STRINGS.viewModes.spread}">
              ${icon(Columns2)}
            </button>
            <button class="ui-button ui-button--tool ${editorState.viewMode === "grid" ? "active" : ""}" id="view-mode-grid" title="${STRINGS.viewModes.grid}">
              ${icon(Grid2X2)}
            </button>
          </div>

          <div class="tool-separator"></div>

          <!-- Zoom controls -->
          <button class="ui-button ui-button--tool" id="btn-zoom-out" title="${STRINGS.viewModes.zoomOut}">
            ${icon(ZoomOut)}
          </button>
          <span class="zoom-readout text-xs font-semibold px-1">${Math.round(editorState.zoom * 100)}%</span>
          <button class="ui-button ui-button--tool" id="btn-zoom-in" title="${STRINGS.viewModes.zoomIn}">
            ${icon(ZoomIn)}
          </button>
          <button class="ui-button ui-button--tool ${fitMode === "fit-width" ? "active" : ""}" id="btn-fit-width" title="${STRINGS.viewModes.fitWidth}">
            ${icon(MoveHorizontal)}
          </button>
          <button class="ui-button ui-button--tool ${fitMode === "fit-page" ? "active" : ""}" id="btn-fit-page" title="${STRINGS.viewModes.fitPage}">
            ${icon(Maximize2)}
          </button>

          <button class="ui-button ui-button--tool" id="btn-find-text" title="Find in document (Ctrl+F)">
            ${icon(Search)} <span>Find</span>
          </button>
          <div class="tool-separator"></div>
        </div>

        <!-- Command Palette Trigger -->
        <button class="ui-button ui-button--tool" id="btn-cmd-palette" title="Command Palette (Ctrl+K)">
          ${icon(Command)}
          <kbd class="palette-shortcut ms-1">Ctrl+K</kbd>
        </button>

        <!-- Keyboard Shortcuts -->
        <button class="ui-button ui-button--tool" id="btn-shortcuts" title="${STRINGS.menu.shortcuts} (?)">
          ${icon(Keyboard)}
        </button>

        <!-- Preferences -->
        <button class="ui-button ui-button--tool" id="btn-preferences" title="${STRINGS.menu.settings} (Ctrl+,)">
          ${icon(Settings)}
        </button>

        <!-- Theme Toggle -->
        <button class="ui-button ui-button--tool" id="btn-theme-toggle" title="Toggle Light / Dark theme">
          ${editorState.theme === "dark" ? icon(Sun) : icon(Moon)}
        </button>
      </div>
    `;

    this.headerElement.classList.toggle("has-document", isDocOpen);
    const title = this.headerElement.querySelector(".doc-title-badge");
    if (title) {
      title.setAttribute("title", editorState.doc?.file_path || docTitle);
      title.querySelector(".truncate")!.textContent = docTitle;
    }
    this.labelButtons(this.headerElement);
    this.bindHeaderEvents();
  }

  private labelButtons(container: HTMLElement) {
    for (const button of container.querySelectorAll<HTMLButtonElement>("button[title]")) {
      button.setAttribute("aria-label", button.title);
      if (
        button.hasAttribute("data-tool") ||
        button.id.startsWith("view-mode-") ||
        button.id === "btn-fit-width" ||
        button.id === "btn-fit-page"
      ) {
        button.setAttribute("aria-pressed", String(button.classList.contains("active")));
      }
    }
  }

  private renderActionToolbar() {
    if (!editorState.doc) {
      this.actionToolbarElement.style.display = "none";
      return;
    }
    this.actionToolbarElement.style.display = "flex";

    const t = editorState.activeTool;

    this.actionToolbarElement.innerHTML = `
      <div class="tool-group">
        <!-- Select & Pan -->
        <button class="ui-button ui-button--tool ${t === "select" ? "active" : ""}" data-tool="select" title="${STRINGS.tools.select} (V)">
          ${icon(MousePointer2)}
        </button>
        <button class="ui-button ui-button--tool ${t === "hand" ? "active" : ""}" data-tool="hand" title="${STRINGS.tools.hand} (H)">
          ${icon(Hand)}
        </button>

        <div class="tool-separator"></div>

        <!-- Markup -->
        <button class="ui-button ui-button--tool ${t === "highlight" ? "active" : ""}" data-tool="highlight" title="${STRINGS.tools.highlight} (Shift+H)">
          ${icon(Highlighter)}
        </button>
        <button class="ui-button ui-button--tool ${t === "highlighter" ? "active" : ""}" data-tool="highlighter" title="${STRINGS.tools.highlighter}">
          ${icon(Brush)}
        </button>
        <button class="ui-button ui-button--tool ${t === "underline" ? "active" : ""}" data-tool="underline" title="${STRINGS.tools.underline}">
          ${icon(Underline)}
        </button>
        <button class="ui-button ui-button--tool ${t === "strikeout" ? "active" : ""}" data-tool="strikeout" title="${STRINGS.tools.strikeout}">
          ${icon(Strikethrough)}
        </button>

        <div class="tool-separator"></div>

        <!-- Text -->
        <button class="ui-button ui-button--tool ${t === "freeText" ? "active" : ""}" data-tool="freeText" title="${STRINGS.tools.freeText} (T)">
          ${icon(Type)}
        </button>
        <button class="ui-button ui-button--tool ${t === "stickyNote" ? "active" : ""}" data-tool="stickyNote" title="${STRINGS.tools.stickyNote}">
          ${icon(MessageSquare)}
        </button>

        <div class="tool-separator"></div>

        <!-- Drawing & Shapes -->
        <button class="ui-button ui-button--tool ${t === "pen" ? "active" : ""}" data-tool="pen" title="${STRINGS.tools.pen} (P)">
          ${icon(PenTool)}
        </button>
        <button class="ui-button ui-button--tool ${t === "rectangle" ? "active" : ""}" data-tool="rectangle" title="${STRINGS.tools.rectangle}">
          ${icon(Square)}
        </button>
        <button class="ui-button ui-button--tool ${t === "circle" ? "active" : ""}" data-tool="circle" title="${STRINGS.tools.circle}">
          ${icon(Circle)}
        </button>
        <button class="ui-button ui-button--tool ${t === "line" ? "active" : ""}" data-tool="line" title="${STRINGS.tools.line}">
          ${icon(Slash)}
        </button>
        <button class="ui-button ui-button--tool ${t === "arrow" ? "active" : ""}" data-tool="arrow" title="${STRINGS.tools.arrow}">
          ${icon(ArrowRight)}
        </button>
        <button class="ui-button ui-button--tool ${t === "stamp" ? "active" : ""}" data-tool="stamp" title="${STRINGS.tools.stamp}">
          ${icon(Stamp)}
        </button>
        <button class="ui-button ui-button--tool" id="btn-signature" title="${STRINGS.menu.signature}">
          ${icon(Signature)}
          <span>Sign</span>
        </button>

        <div class="tool-separator"></div>

        <!-- Erasing & True Redacting -->
        <button class="ui-button ui-button--tool ${t === "coverErase" ? "active" : ""}" data-tool="coverErase" title="${STRINGS.tools.coverErase}">
          ${icon(Eraser)}
          <span class="text-xs">Cover</span>
        </button>
        <button class="ui-button ui-button--tool text-destructive ${t === "trueRedact" ? "active" : ""}" data-tool="trueRedact" title="${STRINGS.tools.trueRedact}">
          ${icon(ShieldAlert)}
          <span class="text-xs font-semibold">Redact text</span>
        </button>

        <div class="tool-separator"></div>

        <!-- Crop -->
        <button class="ui-button ui-button--tool ${t === "crop" ? "active" : ""}" data-tool="crop" title="${STRINGS.tools.crop} (C)">
          ${icon(Crop)}
          <span>Crop</span>
        </button>
      </div>

      <div class="tool-group">
        <!-- Page Operations Quick Toolbar -->
        <button class="ui-button ui-button--tool" id="btn-quick-rotate-ccw" title="${STRINGS.pageOps.rotateCcw}">
          ${icon(RotateCcw)}
        </button>
        <button class="ui-button ui-button--tool" id="btn-quick-rotate-cw" title="${STRINGS.pageOps.rotateCw}">
          ${icon(RotateCw)}
        </button>
        <button class="ui-button ui-button--tool" id="btn-quick-insert-blank" title="${STRINGS.pageOps.insertBlank}">
          ${icon(Plus)}
        </button>
        <button class="ui-button ui-button--tool" id="btn-merge-split" title="${STRINGS.menu.mergeSplit}">
          ${icon(Split)}
        </button>
        <button class="ui-button ui-button--tool" id="btn-watermark" title="${STRINGS.menu.watermark}">
          ${icon(Droplets)}
        </button>
        <button class="ui-button ui-button--tool text-destructive" id="btn-quick-delete" title="${STRINGS.pageOps.deletePage}">
          ${icon(Trash2)}
        </button>
      </div>
    `;

    this.labelButtons(this.actionToolbarElement);
    this.bindActionToolbarEvents();
  }

  private bindHeaderEvents() {
    this.headerElement.querySelector("#btn-find-text")?.addEventListener("click", () => {
      window.dispatchEvent(new Event("open-document-search"));
    });
    this.headerElement.querySelector("#btn-open")?.addEventListener("click", () => {
      void guardedPickPdf();
    });

    this.headerElement.querySelector("#btn-save")?.addEventListener("click", async () => {
      if (!editorState.doc) return;
      try {
        if (!editorState.doc.file_path) {
          void this.handleSaveAs();
          return;
        }
        await Backend.saveDocument(editorState.preferences.makeBackup);
        editorState.doc.is_dirty = false;
        editorState.notify();
        toast.show({ message: STRINGS.toasts.saved, type: "success" });
      } catch (err: any) {
        toast.show({ message: `Save failed: ${err}`, type: "error" });
      }
    });

    this.headerElement.querySelector("#btn-save-as")?.addEventListener("click", () => {
      void this.handleSaveAs();
    });

    this.headerElement.querySelector("#btn-export-print")?.addEventListener("click", () => {
      window.dispatchEvent(new CustomEvent("open-export-print"));
    });

    this.headerElement.querySelector("#btn-metadata")?.addEventListener("click", () => {
      window.dispatchEvent(new CustomEvent("open-metadata"));
    });

    this.headerElement.querySelector("#btn-undo")?.addEventListener("click", () => {
      void editorState.undo();
    });

    this.headerElement.querySelector("#btn-redo")?.addEventListener("click", () => {
      void editorState.redo();
    });

    this.headerElement.querySelector("#btn-zoom-in")?.addEventListener("click", () => {
      editorState.zoomIn();
    });

    this.headerElement.querySelector("#btn-zoom-out")?.addEventListener("click", () => {
      editorState.zoomOut();
    });

    this.headerElement.querySelector("#btn-fit-width")?.addEventListener("click", () => {
      editorState.requestFitWidth();
    });

    this.headerElement.querySelector("#btn-fit-page")?.addEventListener("click", () => {
      editorState.requestFitPage();
    });

    this.headerElement.querySelector("#btn-theme-toggle")?.addEventListener("click", () => {
      editorState.toggleTheme();
    });

    this.headerElement.querySelector("#btn-cmd-palette")?.addEventListener("click", () => {
      window.dispatchEvent(new CustomEvent("open-command-palette"));
    });

    this.headerElement.querySelector("#btn-shortcuts")?.addEventListener("click", () => {
      window.dispatchEvent(new CustomEvent("open-shortcuts"));
    });

    this.headerElement.querySelector("#btn-preferences")?.addEventListener("click", () => {
      window.dispatchEvent(new CustomEvent("open-preferences"));
    });

    // View modes
    const modes: ViewMode[] = ["continuous", "single", "spread", "grid"];
    for (const m of modes) {
      this.headerElement.querySelector(`#view-mode-${m}`)?.addEventListener("click", () => {
        editorState.setViewMode(m);
      });
    }
  }

  private async handleSaveAs() {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const target = await save({
        filters: [{ name: "PDF Document", extensions: ["pdf"] }],
      });
      if (target && typeof target === "string") {
        await Backend.saveDocumentAs(target, editorState.preferences.makeBackup);
        toast.show({ message: `Saved to ${target}`, type: "success" });
        const updated = await Backend.getDocumentState();
        editorState.updateDocument(updated);
      }
    } catch (err: any) {
      toast.show({ message: `Save As failed: ${err}`, type: "error" });
    }
  }

  private bindActionToolbarEvents() {
    this.actionToolbarElement.querySelectorAll("button[data-tool]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tool = btn.getAttribute("data-tool") as ToolType;
        if (tool) {
          editorState.setTool(tool);
        }
      });
    });

    this.actionToolbarElement.querySelector("#btn-signature")?.addEventListener("click", () => {
      window.dispatchEvent(new CustomEvent("open-signature"));
    });

    // Quick rotate CW
    this.actionToolbarElement.querySelector("#btn-quick-rotate-cw")?.addEventListener("click", async () => {
      const pages = editorState.selectedPages.size > 0 ? Array.from(editorState.selectedPages) : [editorState.currentPage];
      try {
        const doc = await Backend.rotatePages(pages, 90);
        editorState.updateDocument(doc);
        toast.show({ message: "Rotated page(s) +90°", type: "info" });
      } catch (err: any) {
        toast.show({ message: err.toString(), type: "error" });
      }
    });

    // Quick rotate CCW
    this.actionToolbarElement.querySelector("#btn-quick-rotate-ccw")?.addEventListener("click", async () => {
      const pages = editorState.selectedPages.size > 0 ? Array.from(editorState.selectedPages) : [editorState.currentPage];
      try {
        const doc = await Backend.rotatePages(pages, -90);
        editorState.updateDocument(doc);
        toast.show({ message: "Rotated page(s) -90°", type: "info" });
      } catch (err: any) {
        toast.show({ message: err.toString(), type: "error" });
      }
    });

    // Insert blank page modal
    this.actionToolbarElement.querySelector("#btn-quick-insert-blank")?.addEventListener("click", () => {
      window.dispatchEvent(new CustomEvent("open-insert-page"));
    });

    // Merge / split modal
    this.actionToolbarElement.querySelector("#btn-merge-split")?.addEventListener("click", () => {
      window.dispatchEvent(new CustomEvent("open-merge-split"));
    });

    // Watermark / headers / page numbers modal
    this.actionToolbarElement.querySelector("#btn-watermark")?.addEventListener("click", () => {
      window.dispatchEvent(new CustomEvent("open-watermark"));
    });

    // Quick delete
    this.actionToolbarElement.querySelector("#btn-quick-delete")?.addEventListener("click", async () => {
      const pages = editorState.selectedPages.size > 0 ? Array.from(editorState.selectedPages) : [editorState.currentPage];
      if (editorState.doc && pages.length >= editorState.doc.page_count) {
        toast.show({ message: "Cannot delete all pages in document", type: "warning" });
        return;
      }
      try {
        const doc = await Backend.deletePages(pages);
        editorState.updateDocument(doc);
        toast.show({ message: `Deleted ${pages.length} page(s)`, type: "info" });
      } catch (err: any) {
        toast.show({ message: err.toString(), type: "error" });
      }
    });
  }
}
