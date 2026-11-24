import { STRINGS } from "../i18n/strings";
import { Backend } from "../ipc/backend";
import { editorState } from "../state/editorState";
import { guardedCloseDocument, guardedNewDocument, guardedPickPdf } from "./UnsavedGuard";

interface PaletteCommand {
  id: string;
  category: string;
  label: string;
  shortcut?: string;
  action: () => void | Promise<void>;
}

export class CommandPaletteView {
  private backdrop: HTMLElement | null = null;
  private input: HTMLInputElement | null = null;
  private resultsContainer: HTMLElement | null = null;
  private selectedIndex = 0;
  private currentMatches: PaletteCommand[] = [];

  constructor() {
    this.createDom();
    this.bindGlobalKeyboard();
  }

  private getCommands(): PaletteCommand[] {
    const isDoc = editorState.doc !== null;

    return [
      // File
      {
        id: "open",
        category: "File",
        label: "Open PDF Document...",
        shortcut: "Ctrl+O",
        action: () => {
          void guardedPickPdf();
        },
      },
      {
        id: "save",
        category: "File",
        label: "Save Document",
        shortcut: "Ctrl+S",
        action: () => {
          document.getElementById("btn-save")?.click();
        },
      },
      {
        id: "save-as",
        category: "File",
        label: "Save Document As...",
        shortcut: "Ctrl+Shift+S",
        action: () => {
          document.getElementById("btn-save-as")?.click();
        },
      },
      {
        id: "new-blank",
        category: "File",
        label: "Create New Blank PDF",
        action: () => {
          void guardedNewDocument();
        },
      },
      {
        id: "close-document",
        category: "File",
        label: "Close Document",
        action: () => {
          void guardedCloseDocument();
        },
      },
      {
        id: "metadata",
        category: "File",
        label: "Document Properties & Metadata...",
        action: () => {
          if (isDoc) window.dispatchEvent(new CustomEvent("open-metadata"));
        },
      },
      {
        id: "merge-split",
        category: "File",
        label: "Merge / Split / Extract Pages...",
        action: () => {
          if (isDoc) window.dispatchEvent(new CustomEvent("open-merge-split"));
        },
      },
      {
        id: "export-print",
        category: "File",
        label: "Export Pages as Images / Print...",
        action: () => {
          if (isDoc) window.dispatchEvent(new CustomEvent("open-export-print"));
        },
      },

      // Tools
      {
        id: "tool-select",
        category: "Tool",
        label: "Select & Move Tool",
        shortcut: "V",
        action: () => editorState.setTool("select"),
      },
      {
        id: "tool-hand",
        category: "Tool",
        label: "Pan / Hand Tool",
        shortcut: "H",
        action: () => editorState.setTool("hand"),
      },
      {
        id: "tool-freetext",
        category: "Tool",
        label: "Add Free Text Box",
        shortcut: "T",
        action: () => editorState.setTool("freeText"),
      },
      {
        id: "tool-sticky-note",
        category: "Tool",
        label: "Sticky Note Tool",
        action: () => editorState.setTool("stickyNote"),
      },
      {
        id: "tool-pen",
        category: "Tool",
        label: "Freehand Pen Tool",
        shortcut: "P",
        action: () => editorState.setTool("pen"),
      },
      {
        id: "tool-highlight",
        category: "Tool",
        label: "Text Highlight Tool",
        shortcut: "Shift+H",
        action: () => editorState.setTool("highlight"),
      },
      {
        id: "tool-underline",
        category: "Tool",
        label: "Underline Tool",
        action: () => editorState.setTool("underline"),
      },
      {
        id: "tool-strikeout",
        category: "Tool",
        label: "Strikethrough Tool",
        action: () => editorState.setTool("strikeout"),
      },
      {
        id: "tool-rect",
        category: "Tool",
        label: "Draw Rectangle",
        action: () => editorState.setTool("rectangle"),
      },
      {
        id: "tool-circle",
        category: "Tool",
        label: "Draw Ellipse / Circle",
        action: () => editorState.setTool("circle"),
      },
      {
        id: "tool-arrow",
        category: "Tool",
        label: "Draw Arrow",
        action: () => editorState.setTool("arrow"),
      },
      {
        id: "tool-stamp",
        category: "Tool",
        label: "Stamp Tool",
        action: () => editorState.setTool("stamp"),
      },
      {
        id: "open-signature",
        category: "Tool",
        label: "Signature & Custom Stamp...",
        action: () => {
          if (isDoc) window.dispatchEvent(new CustomEvent("open-signature"));
        },
      },
      {
        id: "tool-crop",
        category: "Tool",
        label: "Crop Tool",
        shortcut: "C",
        action: () => editorState.setTool("crop"),
      },
      {
        id: "tool-true-redact",
        category: "Tool",
        label: "True Redaction (Permanent Excision)",
        action: () => editorState.setTool("trueRedact"),
      },
      {
        id: "tool-cover-erase",
        category: "Tool",
        label: "Cover Eraser",
        action: () => editorState.setTool("coverErase"),
      },

      // View & Navigation
      {
        id: "view-continuous",
        category: "View",
        label: "Continuous Vertical Scroll",
        action: () => editorState.setViewMode("continuous"),
      },
      {
        id: "view-single",
        category: "View",
        label: "Single Page Mode",
        action: () => editorState.setViewMode("single"),
      },
      {
        id: "view-spread",
        category: "View",
        label: "Two-Page Spread Mode",
        action: () => editorState.setViewMode("spread"),
      },
      {
        id: "view-grid",
        category: "View",
        label: "Grid Overview Mode",
        action: () => editorState.setViewMode("grid"),
      },
      {
        id: "go-to-page",
        category: "View",
        label: "Go to Page...",
        shortcut: "Ctrl+G",
        action: () => {
          if (isDoc) window.dispatchEvent(new CustomEvent("open-page-jump"));
        },
      },
      {
        id: "find-text",
        label: "Find in document",
        category: "View",
        shortcut: "Ctrl+F",
        action: () => {
          window.dispatchEvent(new Event("open-document-search"));
        },
      },
      {
        id: "zoom-fit-width",
        category: "View",
        label: "Zoom: Fit Width",
        action: () => editorState.requestFitWidth(),
      },
      {
        id: "zoom-fit-page",
        category: "View",
        label: "Zoom: Fit Page",
        action: () => editorState.requestFitPage(),
      },
      {
        id: "zoom-in",
        category: "View",
        label: "Zoom In",
        shortcut: "Ctrl++",
        action: () => editorState.zoomIn(),
      },
      {
        id: "zoom-out",
        category: "View",
        label: "Zoom Out",
        shortcut: "Ctrl+-",
        action: () => editorState.zoomOut(),
      },
      {
        id: "zoom-100",
        category: "View",
        label: "Zoom to 100% Actual Size",
        shortcut: "Ctrl+0",
        action: () => editorState.setZoom(1.0),
      },
      {
        id: "sidebar-thumbnails",
        category: "View",
        label: "Sidebar: Page Thumbnails",
        action: () => editorState.setSidebarTab("thumbnails"),
      },
      {
        id: "sidebar-outline",
        category: "View",
        label: "Sidebar: Outline & Bookmarks",
        action: () => editorState.setSidebarTab("outline"),
      },
      {
        id: "sidebar-annotations",
        category: "View",
        label: "Sidebar: Annotations List",
        action: () => editorState.setSidebarTab("annotations"),
      },
      {
        id: "toggle-theme",
        category: "View",
        label: "Toggle Light / Dark Theme",
        shortcut: "Ctrl+T",
        action: () => editorState.toggleTheme(),
      },

      // Page Operations
      {
        id: "page-rotate-cw",
        category: "Page",
        label: "Rotate Selected Pages +90° Clockwise",
        action: async () => {
          if (!isDoc) return;
          const p = editorState.selectedPages.size > 0 ? Array.from(editorState.selectedPages) : [editorState.currentPage];
          const doc = await Backend.rotatePages(p, 90);
          editorState.updateDocument(doc);
        },
      },
      {
        id: "page-rotate-ccw",
        category: "Page",
        label: "Rotate Selected Pages -90° Counter-Clockwise",
        action: async () => {
          if (!isDoc) return;
          const p = editorState.selectedPages.size > 0 ? Array.from(editorState.selectedPages) : [editorState.currentPage];
          const doc = await Backend.rotatePages(p, -90);
          editorState.updateDocument(doc);
        },
      },
      {
        id: "page-insert-blank",
        category: "Page",
        label: "Insert Blank Page...",
        action: () => {
          if (isDoc) window.dispatchEvent(new CustomEvent("open-insert-page"));
        },
      },
      {
        id: "page-watermark",
        category: "Page",
        label: "Watermarks, Headers & Page Numbers...",
        action: () => {
          if (isDoc) window.dispatchEvent(new CustomEvent("open-watermark"));
        },
      },
      {
        id: "page-delete",
        category: "Page",
        label: "Delete Selected Page(s)",
        action: async () => {
          if (!isDoc) return;
          const pages = editorState.selectedPages.size > 0 ? Array.from(editorState.selectedPages) : [editorState.currentPage];
          const doc = await Backend.deletePages(pages);
          editorState.updateDocument(doc);
        },
      },

      // History
      {
        id: "undo",
        category: "Edit",
        label: "Undo Last Action",
        shortcut: "Ctrl+Z",
        action: () => editorState.undo(),
      },
      {
        id: "redo",
        category: "Edit",
        label: "Redo Action",
        shortcut: "Ctrl+Y",
        action: () => editorState.redo(),
      },

      // Preferences & Help
      {
        id: "open-preferences",
        category: "Workspace",
        label: "Preferences...",
        shortcut: "Ctrl+,",
        action: () => {
          window.dispatchEvent(new CustomEvent("open-preferences"));
        },
      },
      {
        id: "open-shortcuts",
        category: "Workspace",
        label: "Keyboard Shortcuts",
        shortcut: "?",
        action: () => {
          window.dispatchEvent(new CustomEvent("open-shortcuts"));
        },
      },
    ];
  }

  private createDom() {
    this.backdrop = document.createElement("div");
    this.backdrop.className = "command-palette-backdrop";
    this.backdrop.style.display = "none";

    this.backdrop.innerHTML = `
      <div class="command-palette-modal" id="palette-modal" role="dialog" aria-label="Command palette">
        <input type="text" class="palette-search-input" id="palette-input" aria-label="Search commands" placeholder="${STRINGS.commandPalette.placeholder}" autocomplete="off" />
        <div class="palette-results-list" id="palette-results"></div>
      </div>
    `;

    document.body.appendChild(this.backdrop);

    this.input = this.backdrop.querySelector("#palette-input");
    this.resultsContainer = this.backdrop.querySelector("#palette-results");

    this.backdrop.addEventListener("click", (e) => {
      if (e.target === this.backdrop) this.close();
    });

    this.input?.addEventListener("input", () => this.filterCommands());
    this.input?.addEventListener("keydown", (e) => this.handleKeyNavigation(e));

    window.addEventListener("open-command-palette", () => this.open());
  }

  open() {
    if (!this.backdrop || !this.input) return;
    this.backdrop.style.display = "flex";
    this.input.value = "";
    this.selectedIndex = 0;
    this.filterCommands();
    this.input.focus();
  }

  close() {
    if (!this.backdrop) return;
    this.backdrop.style.display = "none";
  }

  private isPaletteOpen(): boolean {
    return Boolean(this.backdrop && this.backdrop.style.display !== "none");
  }

  private filterCommands() {
    const query = this.input?.value.trim().toLowerCase() || "";
    const all = this.getCommands();

    this.currentMatches = all.filter(
      (cmd) =>
        cmd.label.toLowerCase().includes(query) ||
        cmd.category.toLowerCase().includes(query) ||
        (cmd.shortcut && cmd.shortcut.toLowerCase().includes(query))
    );

    this.selectedIndex = 0;
    this.renderResults();
  }

  private renderResults() {
    if (!this.resultsContainer) return;
    this.resultsContainer.innerHTML = "";

    if (this.currentMatches.length === 0) {
      this.resultsContainer.innerHTML = `
        <div class="p-4 text-center text-muted-foreground text-xs">${STRINGS.commandPalette.noResults}</div>
      `;
      return;
    }

    this.currentMatches.forEach((cmd, idx) => {
      const item = document.createElement("div");
      item.className = `palette-item ${idx === this.selectedIndex ? "active" : ""}`;
      item.innerHTML = `
        <div class="flex items-center gap-2">
          <span class="ui-badge text-xs">${cmd.category}</span>
          <span class="font-medium">${cmd.label}</span>
        </div>
        ${cmd.shortcut ? `<kbd class="palette-shortcut">${cmd.shortcut}</kbd>` : ""}
      `;

      item.addEventListener("click", () => {
        this.close();
        void cmd.action();
      });

      this.resultsContainer?.appendChild(item);
    });
  }

  private handleKeyNavigation(e: KeyboardEvent) {
    if (e.key === "Escape") {
      this.close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (this.currentMatches.length > 0) {
        this.selectedIndex = (this.selectedIndex + 1) % this.currentMatches.length;
        this.renderResults();
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (this.currentMatches.length > 0) {
        this.selectedIndex = (this.selectedIndex - 1 + this.currentMatches.length) % this.currentMatches.length;
        this.renderResults();
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (this.currentMatches.length > 0 && this.currentMatches[this.selectedIndex]) {
        const cmd = this.currentMatches[this.selectedIndex];
        this.close();
        void cmd.action();
      }
    }
  }

  private bindGlobalKeyboard() {
    window.addEventListener("keydown", (e) => {
      if (editorState.openingFile) return;

      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      if (this.isPaletteOpen() && e.key === "Escape") {
        e.preventDefault();
        this.close();
        return;
      }

      // Ctrl+, / Cmd+, -> Preferences
      if (mod && e.key === ",") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("open-preferences"));
        return;
      }
      // Ctrl+/ or Cmd+/ -> Shortcuts
      if (mod && e.key === "/") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("open-shortcuts"));
        return;
      }
      // Ctrl+K or Cmd+K
      if (mod && key === "k") {
        e.preventDefault();
        this.open();
        return;
      }
      // Ctrl+O
      if (mod && key === "o") {
        e.preventDefault();
        void guardedPickPdf();
        return;
      }
      // Ctrl+S
      if (mod && key === "s") {
        e.preventDefault();
        if (e.shiftKey) {
          document.getElementById("btn-save-as")?.click();
        } else {
          document.getElementById("btn-save")?.click();
        }
        return;
      }
      // Ctrl+G -> Go to page
      if (mod && key === "g" && editorState.doc) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("open-page-jump"));
        return;
      }
      // Ctrl+T -> Toggle theme
      if (mod && key === "t") {
        e.preventDefault();
        editorState.toggleTheme();
        return;
      }
      // Ctrl+Z / Ctrl+Shift+Z
      if (mod && key === "z") {
        e.preventDefault();
        if (e.shiftKey) void editorState.redo();
        else void editorState.undo();
        return;
      }
      // Ctrl+Y
      if (mod && key === "y") {
        e.preventDefault();
        void editorState.redo();
        return;
      }
      // Zoom shortcuts: Ctrl+= / Ctrl++ / Ctrl+- / Ctrl+0
      if (mod && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        editorState.zoomIn();
        return;
      }
      if (mod && e.key === "-") {
        e.preventDefault();
        editorState.zoomOut();
        return;
      }
      if (mod && e.key === "0") {
        e.preventDefault();
        editorState.setZoom(1.0);
        return;
      }

      // Single-key shortcuts when not typing in an input or inside an open dialog/palette
      const target = e.target as HTMLElement | null;
      const targetTag = target?.tagName?.toLowerCase() ?? "";
      if (
        mod ||
        e.altKey ||
        this.isPaletteOpen() ||
        document.querySelector("dialog[open]") ||
        targetTag === "input" ||
        targetTag === "textarea" ||
        targetTag === "select" ||
        target?.isContentEditable
      ) {
        return;
      }

      if (e.key === "?") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("open-shortcuts"));
        return;
      }
      if (key === "v") editorState.setTool("select");
      else if (key === "h") editorState.setTool(e.shiftKey ? "highlight" : "hand");
      else if (key === "t") editorState.setTool("freeText");
      else if (key === "p") editorState.setTool("pen");
      else if (key === "c") editorState.setTool("crop");
    });
  }
}
