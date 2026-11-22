import { STRINGS } from "../i18n/strings";
import { Backend } from "../ipc/backend";
import { editorState } from "../state/editorState";
import { ToolType, ViewMode } from "../types/editor";
import { toast } from "./Toast";

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
          document.getElementById("btn-open")?.click();
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
        action: async () => {
          const doc = await Backend.newDocument();
          editorState.setDocument(doc);
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

      // View
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
          editorState.setDocument(doc);
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
          editorState.setDocument(doc);
        },
      },
      {
        id: "page-insert-blank",
        category: "Page",
        label: "Insert Blank Page After Current",
        action: async () => {
          if (!isDoc) return;
          const doc = await Backend.insertBlankPage(editorState.currentPage + 1, 612.0, 792.0);
          editorState.setDocument(doc);
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
          editorState.setDocument(doc);
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
    ];
  }

  private createDom() {
    this.backdrop = document.createElement("div");
    this.backdrop.className = "command-palette-backdrop";
    this.backdrop.style.display = "none";

    this.backdrop.innerHTML = `
      <div class="command-palette-modal" id="palette-modal">
        <input type="text" class="palette-search-input" id="palette-input" placeholder="${STRINGS.commandPalette.placeholder}" autocomplete="off" />
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
        <div class="p-4 text-center text-muted small">${STRINGS.commandPalette.noResults}</div>
      `;
      return;
    }

    this.currentMatches.forEach((cmd, idx) => {
      const item = document.createElement("div");
      item.className = `palette-item ${idx === this.selectedIndex ? "active" : ""}`;
      item.innerHTML = `
        <div class="d-flex align-items-center gap-2">
          <span class="badge bg-light text-dark border small">${cmd.category}</span>
          <span class="fw-medium">${cmd.label}</span>
        </div>
        ${cmd.shortcut ? `<kbd class="palette-shortcut">${cmd.shortcut}</kbd>` : ""}
      `;

      item.addEventListener("click", () => {
        this.close();
        cmd.action();
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
        cmd.action();
      }
    }
  }

  private bindGlobalKeyboard() {
    window.addEventListener("keydown", (e) => {
      // Ctrl+K or Cmd+K
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        this.open();
        return;
      }
      // Ctrl+O
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") {
        e.preventDefault();
        document.getElementById("btn-open")?.click();
        return;
      }
      // Ctrl+S
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (e.shiftKey) {
          document.getElementById("btn-save-as")?.click();
        } else {
          document.getElementById("btn-save")?.click();
        }
        return;
      }
      // Ctrl+Z
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        if (!e.shiftKey) {
          e.preventDefault();
          editorState.undo();
        }
        return;
      }
      // Ctrl+Y
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        editorState.redo();
        return;
      }
      // Tool shortcuts (V, H, T, P, C) when not inside an input
      const targetTag = (e.target as HTMLElement).tagName.toLowerCase();
      if (targetTag !== "input" && targetTag !== "textarea") {
        if (e.key.toLowerCase() === "v") editorState.setTool("select");
        if (e.key.toLowerCase() === "h") editorState.setTool("hand");
        if (e.key.toLowerCase() === "t") editorState.setTool("freeText");
        if (e.key.toLowerCase() === "p") editorState.setTool("pen");
        if (e.key.toLowerCase() === "c") editorState.setTool("crop");
      }
    });
  }
}
