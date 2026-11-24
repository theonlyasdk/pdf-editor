import { Keyboard, Search, X } from "lucide";
import { STRINGS } from "../i18n/strings";
import { icon } from "./ui/icon";

export interface ShortcutEntry {
  category: string;
  label: string;
  keys: string;
}

export const KEYBOARD_SHORTCUTS: ShortcutEntry[] = [
  // File
  { category: "File", label: "Open PDF document", keys: "Ctrl+O" },
  { category: "File", label: "Save document", keys: "Ctrl+S" },
  { category: "File", label: "Save document as", keys: "Ctrl+Shift+S" },

  // Navigation & View
  { category: "View", label: "Find in document", keys: "Ctrl+F" },
  { category: "View", label: "Go to page", keys: "Ctrl+G" },
  { category: "View", label: "Zoom in", keys: "Ctrl++" },
  { category: "View", label: "Zoom out", keys: "Ctrl+-" },
  { category: "View", label: "Zoom to 100% actual size", keys: "Ctrl+0" },
  { category: "View", label: "Zoom with scroll wheel", keys: "Ctrl+Wheel" },
  { category: "View", label: "Toggle Light / Dark theme", keys: "Ctrl+T" },

  // Edit
  { category: "Edit", label: "Undo last action", keys: "Ctrl+Z" },
  { category: "Edit", label: "Redo action", keys: "Ctrl+Y" },

  // Tools
  { category: "Tools", label: "Select & move tool", keys: "V" },
  { category: "Tools", label: "Hand / pan tool", keys: "H" },
  { category: "Tools", label: "Text highlight tool", keys: "Shift+H" },
  { category: "Tools", label: "Free text box tool", keys: "T" },
  { category: "Tools", label: "Freehand pen tool", keys: "P" },
  { category: "Tools", label: "Crop pages tool", keys: "C" },
  { category: "Tools", label: "Apply active crop", keys: "Enter" },
  { category: "Tools", label: "Cancel active crop", keys: "Esc" },
  { category: "Tools", label: "Lock crop aspect ratio while dragging", keys: "Hold Ctrl" },

  // Workspace
  { category: "Workspace", label: "Open command palette", keys: "Ctrl+K" },
  { category: "Workspace", label: "Open preferences", keys: "Ctrl+," },
  { category: "Workspace", label: "Show keyboard shortcuts", keys: "?" },
  { category: "Workspace", label: "Close active modal or search", keys: "Esc" },
];

export class ShortcutsModalView {
  private dialog: HTMLDialogElement;
  private input: HTMLInputElement | null = null;
  private listEl: HTMLElement | null = null;
  private focusReturn: HTMLElement | null = null;

  constructor() {
    this.dialog = document.createElement("dialog");
    this.dialog.className = "editor-modal shortcuts-modal";
    this.dialog.setAttribute("aria-labelledby", "shortcuts-modal-title");
    this.dialog.innerHTML = `
      <div class="editor-modal-card">
        <header class="editor-modal-header">
          <div class="editor-modal-title-wrap">
            ${icon(Keyboard, 18)}
            <h2 id="shortcuts-modal-title">${STRINGS.shortcuts.title}</h2>
          </div>
          <button type="button" class="ui-button ui-button--tool" id="shortcuts-close-btn" aria-label="Close">
            ${icon(X)}
          </button>
        </header>

        <div class="shortcuts-search-bar">
          ${icon(Search, 15)}
          <input
            type="search"
            class="ui-input"
            id="shortcuts-search-input"
            aria-label="Search keyboard shortcuts"
            placeholder="${STRINGS.shortcuts.searchPlaceholder}"
            autocomplete="off"
          />
        </div>

        <div class="editor-modal-body shortcuts-list" id="shortcuts-list"></div>
      </div>
    `;
    document.body.appendChild(this.dialog);

    this.input = this.dialog.querySelector("#shortcuts-search-input");
    this.listEl = this.dialog.querySelector("#shortcuts-list");

    this.dialog.querySelector("#shortcuts-close-btn")?.addEventListener("click", () => this.close());
    this.dialog.addEventListener("click", (e) => {
      if (e.target === this.dialog) this.close();
    });
    this.dialog.addEventListener("close", () => {
      if (this.focusReturn?.isConnected) {
        this.focusReturn.focus({ preventScroll: true });
      }
      this.focusReturn = null;
    });
    this.input?.addEventListener("input", () => this.renderList());

    window.addEventListener("open-shortcuts", () => this.open());
  }

  open() {
    if (this.dialog.open) return;
    this.focusReturn = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (this.input) this.input.value = "";
    this.renderList();
    this.dialog.showModal();
    this.input?.focus();
  }

  close() {
    if (this.dialog.open) this.dialog.close();
  }

  private renderList() {
    if (!this.listEl) return;
    const query = this.input?.value.trim().toLowerCase() ?? "";
    const filtered = KEYBOARD_SHORTCUTS.filter(
      (item) =>
        !query ||
        item.label.toLowerCase().includes(query) ||
        item.category.toLowerCase().includes(query) ||
        item.keys.toLowerCase().includes(query)
    );

    if (filtered.length === 0) {
      this.listEl.innerHTML = `<p class="shortcuts-empty">${STRINGS.shortcuts.noResults}</p>`;
      return;
    }

    const groups = new Map<string, ShortcutEntry[]>();
    for (const entry of filtered) {
      const list = groups.get(entry.category) ?? [];
      list.push(entry);
      groups.set(entry.category, list);
    }

    this.listEl.innerHTML = "";
    for (const [category, entries] of groups) {
      const section = document.createElement("section");
      section.className = "shortcuts-group";

      const heading = document.createElement("h3");
      heading.className = "prefs-section-title";
      heading.textContent = category;
      section.appendChild(heading);

      for (const entry of entries) {
        const row = document.createElement("div");
        row.className = "shortcut-row";

        const label = document.createElement("span");
        label.textContent = entry.label;

        const kbd = document.createElement("kbd");
        kbd.className = "palette-shortcut";
        kbd.textContent = entry.keys;

        row.append(label, kbd);
        section.appendChild(row);
      }

      this.listEl.appendChild(section);
    }
  }
}
