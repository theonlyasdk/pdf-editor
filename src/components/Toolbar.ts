import { pickPdf } from "./OpenPdf";
import { FileText, FolderOpen, Save, Download, Undo2, Redo2, PanelsTopLeft, RectangleVertical, Columns2, Grid2X2, ZoomOut, ZoomIn, Search, Sun, Moon, MousePointer2, Hand, Highlighter, Underline, Strikethrough, Type, MessageSquare, PenTool, Square, Circle, Slash, ArrowRight, Stamp, Eraser, ShieldAlert, Crop, RotateCcw, RotateCw, Plus, Trash2 } from "lucide";
import { icon } from "./ui/icon";
import { STRINGS } from "../i18n/strings";
import { Backend } from "../ipc/backend";
import { editorState } from "../state/editorState";
import { ToolType, ViewMode } from "../types/editor";
import { toast } from "./Toast";

export class ToolbarView {
  private headerElement: HTMLElement;
  private actionToolbarElement: HTMLElement;

  constructor(header: HTMLElement, actionToolbar: HTMLElement) {
    this.headerElement = header;
    this.actionToolbarElement = actionToolbar;
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
          <button class="ui-button ui-button--tool" id="btn-save-as" ${!isDocOpen ? "disabled" : ""} title="${STRINGS.menu.saveAs}">
            ${icon(Download)}
            <span>Save As...</span>
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
          <span class="text-xs font-semibold px-1" style="min-width: 44px; text-align: center;">${Math.round(editorState.zoom * 100)}%</span>
          <button class="ui-button ui-button--tool" id="btn-zoom-in" title="${STRINGS.viewModes.zoomIn}">
            ${icon(ZoomIn)}
          </button>

          <div class="tool-separator"></div>
        </div>

        <!-- Command Palette Trigger -->
        <button class="ui-button ui-button--tool" id="btn-cmd-palette" title="Command Palette (Ctrl+K)">
          ${icon(Search)}
          <kbd class="palette-shortcut ms-1">Ctrl+K</kbd>
        </button>

        <!-- Theme Toggle -->
        <button class="ui-button ui-button--tool" id="btn-theme-toggle" title="Toggle Light / Dark theme">
          ${
            editorState.theme === "dark"
              ? icon(Sun)
              : icon(Moon)
          }
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
      if (button.hasAttribute("data-tool") || button.id.startsWith("view-mode-")) {
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

        <div class="tool-separator"></div>

        <!-- Erasing & True Redacting -->
        <button class="ui-button ui-button--tool ${t === "coverErase" ? "active" : ""}" data-tool="coverErase" title="${STRINGS.tools.coverErase}">
          ${icon(Eraser)}
          <span class="text-xs">Cover</span>
        </button>
        <button class="ui-button ui-button--tool text-destructive ${t === "trueRedact" ? "active" : ""}" data-tool="trueRedact" title="${STRINGS.tools.trueRedact}">
          ${icon(ShieldAlert)}
          <span class="text-xs font-semibold">True Redact</span>
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
        <button class="ui-button ui-button--tool text-destructive" id="btn-quick-delete" title="${STRINGS.pageOps.deletePage}">
          ${icon(Trash2)}
        </button>
      </div>
    `;

    this.labelButtons(this.actionToolbarElement);
    this.bindActionToolbarEvents();
  }

  private bindHeaderEvents() {
    this.headerElement.querySelector("#btn-open")?.addEventListener("click", pickPdf);

    this.headerElement.querySelector("#btn-save")?.addEventListener("click", async () => {
      if (!editorState.doc) return;
      try {
        if (!editorState.doc.file_path) {
          this.handleSaveAs();
          return;
        }
        await Backend.saveDocument(true);
        editorState.doc.is_dirty = false;
        editorState.notify();
        toast.show({ message: STRINGS.toasts.saved, type: "success" });
      } catch (err: any) {
        toast.show({ message: `Save failed: ${err}`, type: "error" });
      }
    });

    this.headerElement.querySelector("#btn-save-as")?.addEventListener("click", () => {
      this.handleSaveAs();
    });

    this.headerElement.querySelector("#btn-undo")?.addEventListener("click", () => {
      editorState.undo();
    });

    this.headerElement.querySelector("#btn-redo")?.addEventListener("click", () => {
      editorState.redo();
    });

    this.headerElement.querySelector("#btn-zoom-in")?.addEventListener("click", () => {
      editorState.zoomIn();
    });

    this.headerElement.querySelector("#btn-zoom-out")?.addEventListener("click", () => {
      editorState.zoomOut();
    });

    this.headerElement.querySelector("#btn-theme-toggle")?.addEventListener("click", () => {
      editorState.toggleTheme();
    });

    this.headerElement.querySelector("#btn-cmd-palette")?.addEventListener("click", () => {
      window.dispatchEvent(new CustomEvent("open-command-palette"));
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
        await Backend.saveDocumentAs(target, false);
        toast.show({ message: `Saved to ${target}`, type: "success" });
        const updated = await Backend.getDocumentState();
        editorState.setDocument(updated);
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

    // Quick rotate CW
    this.actionToolbarElement.querySelector("#btn-quick-rotate-cw")?.addEventListener("click", async () => {
      const pages = editorState.selectedPages.size > 0 ? Array.from(editorState.selectedPages) : [editorState.currentPage];
      try {
        const doc = await Backend.rotatePages(pages, 90);
        editorState.setDocument(doc);
        toast.show({ message: `Rotated page(s) +90Â°`, type: "info" });
      } catch (err: any) {
        toast.show({ message: err.toString(), type: "error" });
      }
    });

    // Quick rotate CCW
    this.actionToolbarElement.querySelector("#btn-quick-rotate-ccw")?.addEventListener("click", async () => {
      const pages = editorState.selectedPages.size > 0 ? Array.from(editorState.selectedPages) : [editorState.currentPage];
      try {
        const doc = await Backend.rotatePages(pages, -90);
        editorState.setDocument(doc);
        toast.show({ message: `Rotated page(s) -90Â°`, type: "info" });
      } catch (err: any) {
        toast.show({ message: err.toString(), type: "error" });
      }
    });

    // Quick insert blank
    this.actionToolbarElement.querySelector("#btn-quick-insert-blank")?.addEventListener("click", async () => {
      try {
        const at = editorState.currentPage + 1;
        const doc = await Backend.insertBlankPage(at, 612.0, 792.0);
        editorState.setDocument(doc);
        editorState.setCurrentPage(at);
        toast.show({ message: `Inserted blank page at ${at + 1}`, type: "success" });
      } catch (err: any) {
        toast.show({ message: err.toString(), type: "error" });
      }
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
        editorState.setDocument(doc);
        toast.show({ message: `Deleted ${pages.length} page(s)`, type: "info" });
      } catch (err: any) {
        toast.show({ message: err.toString(), type: "error" });
      }
    });
  }
}
