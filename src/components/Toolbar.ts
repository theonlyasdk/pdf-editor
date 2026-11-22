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
        <div class="app-brand me-2">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-primary"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="12" y1="18" x2="12" y2="12"></line><line x1="9" y1="15" x2="15" y2="15"></line></svg>
          <span>${STRINGS.app.title}</span>
        </div>
        <button class="btn-tool" id="btn-open" title="${STRINGS.menu.open} (${STRINGS.menu.openShortcut})">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
          <span>Open</span>
        </button>
        <button class="btn-tool" id="btn-save" ${!isDocOpen ? "disabled" : ""} title="${STRINGS.menu.save} (${STRINGS.menu.saveShortcut})">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg>
          <span>Save</span>
        </button>
        <button class="btn-tool" id="btn-save-as" ${!isDocOpen ? "disabled" : ""} title="${STRINGS.menu.saveAs}">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
          <span>Save As...</span>
        </button>
        <div class="tool-separator"></div>
        <button class="btn-tool" id="btn-undo" ${!canUndo ? "disabled" : ""} title="Undo (Ctrl+Z)">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 14 4 9 9 4"></polyline><path d="M20 20v-7a4 4 0 0 0-4-4H4"></path></svg>
        </button>
        <button class="btn-tool" id="btn-redo" ${!canRedo ? "disabled" : ""} title="Redo (Ctrl+Y)">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 14 20 9 15 4"></polyline><path d="M4 20v-7a4 4 0 0 1 4-4h12"></path></svg>
        </button>
      </div>

      <div class="header-center">
        ${
          isDocOpen
            ? `<div class="doc-title-badge" title="${editorState.doc?.file_path || docTitle}">
                ${isDirty ? `<span class="dirty-indicator" title="Unsaved changes"></span>` : ""}
                <span class="text-truncate">${docTitle}</span>
              </div>`
            : ""
        }
      </div>

      <div class="header-right">
        <!-- View mode buttons -->
        <div class="btn-group btn-group-sm me-1" role="group">
          <button class="btn-tool ${editorState.viewMode === "continuous" ? "active" : ""}" id="view-mode-continuous" title="${STRINGS.viewModes.continuous}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="2" width="14" height="20" rx="2"></rect><line x1="5" y1="12" x2="19" y2="12"></line></svg>
          </button>
          <button class="btn-tool ${editorState.viewMode === "single" ? "active" : ""}" id="view-mode-single" title="${STRINGS.viewModes.single}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="3" width="14" height="18" rx="2"></rect></svg>
          </button>
          <button class="btn-tool ${editorState.viewMode === "spread" ? "active" : ""}" id="view-mode-spread" title="${STRINGS.viewModes.spread}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="9" height="16" rx="1"></rect><rect x="13" y="4" width="9" height="16" rx="1"></rect></svg>
          </button>
          <button class="btn-tool ${editorState.viewMode === "grid" ? "active" : ""}" id="view-mode-grid" title="${STRINGS.viewModes.grid}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>
          </button>
        </div>

        <div class="tool-separator"></div>

        <!-- Zoom controls -->
        <button class="btn-tool" id="btn-zoom-out" title="${STRINGS.viewModes.zoomOut}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line><line x1="8" y1="11" x2="14" y2="11"></line></svg>
        </button>
        <span class="small fw-semibold px-1" style="min-width: 44px; text-align: center;">${Math.round(editorState.zoom * 100)}%</span>
        <button class="btn-tool" id="btn-zoom-in" title="${STRINGS.viewModes.zoomIn}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line><line x1="11" y1="8" x2="11" y2="14"></line><line x1="8" y1="11" x2="14" y2="11"></line></svg>
        </button>

        <div class="tool-separator"></div>

        <!-- Command Palette Trigger -->
        <button class="btn-tool" id="btn-cmd-palette" title="Command Palette (Ctrl+K)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
          <kbd class="palette-shortcut ms-1">Ctrl+K</kbd>
        </button>

        <!-- Theme Toggle -->
        <button class="btn-tool" id="btn-theme-toggle" title="Toggle Light / Dark theme">
          ${
            editorState.theme === "dark"
              ? `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>`
              : `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>`
          }
        </button>
      </div>
    `;

    this.bindHeaderEvents();
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
        <button class="btn-tool ${t === "select" ? "active" : ""}" data-tool="select" title="${STRINGS.tools.select} (V)">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3l7 18 3-7 7-3L3 3z"></path></svg>
        </button>
        <button class="btn-tool ${t === "hand" ? "active" : ""}" data-tool="hand" title="${STRINGS.tools.hand} (H)">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 11V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v0"></path><path d="M14 10V4a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v2"></path><path d="M10 10.5V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v8"></path><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"></path></svg>
        </button>

        <div class="tool-separator"></div>

        <!-- Markup -->
        <button class="btn-tool ${t === "highlight" ? "active" : ""}" data-tool="highlight" title="${STRINGS.tools.highlight} (Shift+H)">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
        </button>
        <button class="btn-tool ${t === "underline" ? "active" : ""}" data-tool="underline" title="${STRINGS.tools.underline}">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 3v7a6 6 0 0 0 12 0V3"></path><line x1="4" y1="21" x2="20" y2="21"></line></svg>
        </button>
        <button class="btn-tool ${t === "strikeout" ? "active" : ""}" data-tool="strikeout" title="${STRINGS.tools.strikeout}">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 4H9a3 3 0 0 0-2.83 4"></path><path d="M14 12v.01"></path><path d="M17.83 16A3 3 0 0 1 15 20H8"></path><line x1="4" y1="12" x2="20" y2="12"></line></svg>
        </button>

        <div class="tool-separator"></div>

        <!-- Text -->
        <button class="btn-tool ${t === "freeText" ? "active" : ""}" data-tool="freeText" title="${STRINGS.tools.freeText} (T)">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 7 4 4 20 4 20 7"></polyline><line x1="9" y1="20" x2="15" y2="20"></line><line x1="12" y1="4" x2="12" y2="20"></line></svg>
        </button>
        <button class="btn-tool ${t === "stickyNote" ? "active" : ""}" data-tool="stickyNote" title="${STRINGS.tools.stickyNote}">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
        </button>

        <div class="tool-separator"></div>

        <!-- Drawing & Shapes -->
        <button class="btn-tool ${t === "pen" ? "active" : ""}" data-tool="pen" title="${STRINGS.tools.pen} (P)">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19l7-7 3 3-7 7-3-3z"></path><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"></path><path d="M2 2l7.586 7.586"></path><circle cx="11" cy="11" r="2"></circle></svg>
        </button>
        <button class="btn-tool ${t === "rectangle" ? "active" : ""}" data-tool="rectangle" title="${STRINGS.tools.rectangle}">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"></rect></svg>
        </button>
        <button class="btn-tool ${t === "circle" ? "active" : ""}" data-tool="circle" title="${STRINGS.tools.circle}">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle></svg>
        </button>
        <button class="btn-tool ${t === "line" ? "active" : ""}" data-tool="line" title="${STRINGS.tools.line}">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="19" x2="19" y2="5"></line></svg>
        </button>
        <button class="btn-tool ${t === "arrow" ? "active" : ""}" data-tool="arrow" title="${STRINGS.tools.arrow}">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>
        </button>
        <button class="btn-tool ${t === "stamp" ? "active" : ""}" data-tool="stamp" title="${STRINGS.tools.stamp}">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"></rect><circle cx="12" cy="12" r="4"></circle></svg>
        </button>

        <div class="tool-separator"></div>

        <!-- Erasing & True Redacting -->
        <button class="btn-tool ${t === "coverErase" ? "active" : ""}" data-tool="coverErase" title="${STRINGS.tools.coverErase}">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 20H7L3 16C2 15 2 13 3 12L13 2L22 11L20 20Z"></path><path d="M11 14L17 8"></path></svg>
          <span class="small">Cover</span>
        </button>
        <button class="btn-tool text-danger ${t === "trueRedact" ? "active" : ""}" data-tool="trueRedact" title="${STRINGS.tools.trueRedact}">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" fill="currentColor"></rect></svg>
          <span class="small fw-bold">True Redact</span>
        </button>

        <div class="tool-separator"></div>

        <!-- Crop -->
        <button class="btn-tool ${t === "crop" ? "active" : ""}" data-tool="crop" title="${STRINGS.tools.crop} (C)">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 2v14a2 2 0 0 0 2 2h14"></path><path d="M18 22V8a2 2 0 0 0-2-2H2"></path></svg>
          <span>Crop</span>
        </button>
      </div>

      <div class="tool-group">
        <!-- Page Operations Quick Toolbar -->
        <button class="btn-tool" id="btn-quick-rotate-ccw" title="${STRINGS.pageOps.rotateCcw}">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><path d="M3 3v5h5"></path></svg>
        </button>
        <button class="btn-tool" id="btn-quick-rotate-cw" title="${STRINGS.pageOps.rotateCw}">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.85.99 6.74 2.74L21 8"></path><path d="M21 3v5h-5"></path></svg>
        </button>
        <button class="btn-tool" id="btn-quick-insert-blank" title="${STRINGS.pageOps.insertBlank}">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
        </button>
        <button class="btn-tool text-danger" id="btn-quick-delete" title="${STRINGS.pageOps.deletePage}">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
        </button>
      </div>
    `;

    this.bindActionToolbarEvents();
  }

  private bindHeaderEvents() {
    this.headerElement.querySelector("#btn-open")?.addEventListener("click", async () => {
      try {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const selected = await open({
          multiple: false,
          filters: [{ name: "PDF Files", extensions: ["pdf"] }],
        });
        if (selected && typeof selected === "string") {
          const doc = await Backend.openDocument(selected);
          editorState.setDocument(doc);
          toast.show({ message: `Opened '${doc.file_name}'`, type: "success" });
        }
      } catch (err: any) {
        toast.show({ message: err.toString(), type: "error" });
      }
    });

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
        toast.show({ message: `Rotated page(s) +90°`, type: "info" });
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
        toast.show({ message: `Rotated page(s) -90°`, type: "info" });
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
