import {
  ArrowRight,
  Brush,
  ChevronDown,
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
  MoreHorizontal,
  MousePointer2,
  MoveHorizontal,
  PanelRightClose,
  PanelRightOpen,
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
  Crop,
} from "lucide";
import { STRINGS } from "../i18n/strings";
import { Backend } from "../ipc/backend";
import { editorState } from "../state/editorState";
import { ToolType, ViewMode } from "../types/editor";
import { showContextMenu, showToolMenu } from "./EditorContextMenu";
import { toast } from "./Toast";
import { guardedPickPdf } from "./UnsavedGuard";
import { icon } from "./ui/icon";

export class ToolbarView {
  private headerElement: HTMLElement;
  private actionToolbarElement: HTMLElement;
  private lastHeaderKey = "";
  private lastActionKey = "";
  private isRenamingDoc = false;
  private headerResizeObserver: ResizeObserver | null = null;
  private actionResizeObserver: ResizeObserver | null = null;
  private overflowedActionButtons: HTMLButtonElement[] = [];

  constructor(header: HTMLElement, actionToolbar: HTMLElement) {
    this.headerElement = header;
    this.actionToolbarElement = actionToolbar;
    if (typeof ResizeObserver !== "undefined") {
      this.headerResizeObserver = new ResizeObserver(() => this.syncHeaderCompactMode());
      this.headerResizeObserver.observe(this.headerElement);
      this.actionResizeObserver = new ResizeObserver(() => this.syncActionToolbarOverflow());
      this.actionResizeObserver.observe(this.actionToolbarElement);
    }
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
    if (this.isRenamingDoc) return;
    const isDocOpen = editorState.doc !== null;
    const docTitle = editorState.doc ? editorState.doc.file_name : STRINGS.app.untitled;
    const filePath = editorState.doc?.file_path ?? "";
    const isDirty = editorState.doc?.is_dirty ?? false;
    const canUndo = editorState.doc?.can_undo ?? false;
    const canRedo = editorState.doc?.can_redo ?? false;
    const fitMode = editorState.zoomFitMode;
    const propsCollapsed = editorState.propertiesCollapsed;
    const headerKey = `${isDocOpen}:${docTitle}:${filePath}:${isDirty}:${canUndo}:${canRedo}:${editorState.viewMode}:${fitMode}:${editorState.theme}:${propsCollapsed}`;

    if (this.lastHeaderKey === headerKey) {
      return;
    }
    this.lastHeaderKey = headerKey;

    this.headerElement.innerHTML = `
      <div class="header-left">
        <button type="button" class="app-brand mr-2" id="btn-about" title="About ${STRINGS.app.title}" aria-label="About ${STRINGS.app.title}">
          ${icon(FileText)}
          <span class="app-brand-label">${STRINGS.app.title}</span>
        </button>
        <button class="ui-button ui-button--tool" id="btn-file-menu" type="button" title="File menu" aria-label="File menu" aria-haspopup="menu">
          ${icon(FolderOpen)}
          ${icon(ChevronDown, 12)}
        </button>
        <button class="ui-button ui-button--tool file-action-expanded" id="btn-open" title="${STRINGS.menu.open} (${STRINGS.menu.openShortcut})">
          ${icon(FolderOpen)}
        </button>
        <div class="document-controls">
          <button class="ui-button ui-button--tool file-action-expanded" id="btn-save" ${!isDocOpen ? "disabled" : ""} title="${STRINGS.menu.save} (${STRINGS.menu.saveShortcut})">
            ${icon(Save)}
          </button>
          <button class="ui-button ui-button--tool file-action-expanded" id="btn-save-as" ${!isDocOpen ? "disabled" : ""} title="${STRINGS.menu.saveAs} (${STRINGS.menu.saveAsShortcut})">
            ${icon(Download)}
          </button>
          <button class="ui-button ui-button--tool file-action-expanded" id="btn-export-print" ${!isDocOpen ? "disabled" : ""} title="${STRINGS.menu.exportPrint}">
            ${icon(Printer)}
          </button>
          <button class="ui-button ui-button--tool file-action-expanded" id="btn-metadata" ${!isDocOpen ? "disabled" : ""} title="${STRINGS.menu.metadata}">
            ${icon(Info)}
          </button>
          <div class="tool-separator file-action-expanded"></div>
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
            ? `<button type="button" class="doc-title-badge" id="btn-rename-doc" aria-label="Rename document">
                ${isDirty ? `<span class="dirty-indicator" title="Unsaved changes"></span>` : ""}
                <span class="truncate"></span>
              </button>`
            : ""
        }
      </div>

      <div class="header-right">
        <div class="document-controls">
          <!-- View mode buttons -->
          <div class="ui-button-group mr-1 header-right-expanded" role="group">
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

          <div class="tool-separator header-right-expanded"></div>

          <!-- Fit & Find controls -->
          <button class="ui-button ui-button--tool header-right-expanded ${fitMode === "fit-width" ? "active" : ""}" id="btn-fit-width" title="${STRINGS.viewModes.fitWidth}">
            ${icon(MoveHorizontal)}
          </button>
          <button class="ui-button ui-button--tool header-right-expanded ${fitMode === "fit-page" ? "active" : ""}" id="btn-fit-page" title="${STRINGS.viewModes.fitPage}">
            ${icon(Maximize2)}
          </button>

          <button class="ui-button ui-button--tool" id="btn-find-text" title="Find in document (Ctrl+F)">
            ${icon(Search)}
          </button>
          <button class="ui-button ui-button--tool header-right-expanded ${!propsCollapsed ? "active" : ""}" id="btn-toggle-properties" title="${propsCollapsed ? "Show Properties panel" : "Hide Properties panel"}">
            ${propsCollapsed ? icon(PanelRightOpen) : icon(PanelRightClose)}
          </button>
          <div class="tool-separator header-right-expanded"></div>
        </div>

        <!-- Command Palette Trigger -->
        <button class="ui-button ui-button--tool" id="btn-cmd-palette" title="Command Palette (Ctrl+K)">
          ${icon(Command)}
        </button>

        <!-- Keyboard Shortcuts -->
        <button class="ui-button ui-button--tool header-right-expanded" id="btn-shortcuts" title="${STRINGS.menu.shortcuts} (?)">
          ${icon(Keyboard)}
        </button>

        <!-- Preferences -->
        <button class="ui-button ui-button--tool" id="btn-preferences" title="${STRINGS.menu.settings} (Ctrl+,)">
          ${icon(Settings)}
        </button>

        <!-- Theme Toggle -->
        <button class="ui-button ui-button--tool header-right-expanded" id="btn-theme-toggle" title="Toggle Light / Dark theme">
          ${editorState.theme === "dark" ? icon(Sun) : icon(Moon)}
        </button>

        <!-- Compact Right Overflow Menu -->
        <button class="ui-button ui-button--tool" id="btn-header-right-menu" type="button" title="More view &amp; app options" aria-label="More view and app options" aria-haspopup="menu">
          ${icon(MoreHorizontal)}
        </button>
      </div>
    `;

    this.headerElement.classList.toggle("has-document", isDocOpen);
    const title = this.headerElement.querySelector("#btn-rename-doc");
    if (title) {
      const fullLabel = editorState.doc?.file_path || docTitle;
      title.setAttribute("title", `${fullLabel} — Click to rename`);
      title.querySelector(".truncate")!.textContent = docTitle;
    }
    this.labelButtons(this.headerElement);
    this.bindHeaderEvents();
    this.syncHeaderCompactMode();
  }

  private syncHeaderCompactMode() {
    const header = this.headerElement;
    const available = header.clientWidth;
    if (available <= 0) return;

    const left = header.querySelector<HTMLElement>(".header-left");
    const right = header.querySelector<HTMLElement>(".header-right");
    if (!left || !right) return;

    const wasCompact = header.classList.contains("compact-header");
    if (wasCompact) header.classList.remove("compact-header");

    const padding = 24;
    const minTitleReserve = editorState.doc ? 140 : 16;
    const needed = left.scrollWidth + right.scrollWidth + minTitleReserve + padding;
    const shouldCompact = available < needed;
    header.classList.toggle("compact-header", shouldCompact);
  }

  private labelButtons(container: HTMLElement) {
    for (const button of container.querySelectorAll<HTMLButtonElement>("button[title]")) {
      if (button.id === "btn-rename-doc") continue;
      button.setAttribute("aria-label", button.title);
      if (
        button.hasAttribute("data-tool") ||
        button.id.startsWith("view-mode-") ||
        button.id === "btn-fit-width" ||
        button.id === "btn-fit-page" ||
        button.id === "btn-toggle-properties"
      ) {
        button.setAttribute("aria-pressed", String(button.classList.contains("active")));
      }
    }
  }

  private renderActionToolbar() {
    if (!editorState.doc) {
      this.actionToolbarElement.style.display = "none";
      this.lastActionKey = "";
      return;
    }
    this.actionToolbarElement.style.display = "flex";

    const t = editorState.activeTool;
    const actionKey = `open:${t}`;
    if (this.lastActionKey === actionKey) {
      return;
    }
    this.lastActionKey = actionKey;

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
      <button class="ui-button ui-button--tool action-overflow-btn" id="btn-action-overflow" type="button" title="More tools" aria-label="More tools" aria-haspopup="menu" hidden>
        ${icon(MoreHorizontal)}
      </button>
    `;

    this.labelButtons(this.actionToolbarElement);
    this.bindActionToolbarEvents();
    this.syncActionToolbarOverflow();
  }

  private syncActionToolbarOverflow() {
    const bar = this.actionToolbarElement;
    const overflowBtn = bar.querySelector<HTMLButtonElement>("#btn-action-overflow");
    if (!overflowBtn || !editorState.doc) return;

    const groups = Array.from(bar.querySelectorAll<HTMLElement>(".tool-group"));
    const allButtons = groups.flatMap((g) => Array.from(g.querySelectorAll<HTMLButtonElement>("button.ui-button--tool")));
    const allSeps = groups.flatMap((g) => Array.from(g.querySelectorAll<HTMLElement>(".tool-separator")));

    for (const btn of allButtons) btn.classList.remove("action-overflow-hidden");
    for (const sep of allSeps) sep.classList.remove("action-overflow-hidden");
    overflowBtn.hidden = true;
    this.overflowedActionButtons = [];

    const available = bar.clientWidth;
    if (available <= 0 || bar.scrollWidth <= available + 1) return;

    overflowBtn.hidden = false;
    const barRect = bar.getBoundingClientRect();
    const overflowWidth = overflowBtn.offsetWidth || 30;
    const limit = barRect.right - overflowWidth - 16;

    for (const btn of allButtons) {
      const rect = btn.getBoundingClientRect();
      if (rect.right > limit) {
        btn.classList.add("action-overflow-hidden");
        this.overflowedActionButtons.push(btn);
      }
    }

    for (const sep of allSeps) {
      let hasPrev = false;
      let prev = sep.previousElementSibling;
      while (prev) {
        if (!prev.classList.contains("action-overflow-hidden") && !prev.classList.contains("tool-separator")) {
          hasPrev = true;
          break;
        }
        prev = prev.previousElementSibling;
      }
      let hasNext = false;
      let next = sep.nextElementSibling;
      while (next) {
        if (!next.classList.contains("action-overflow-hidden") && !next.classList.contains("tool-separator")) {
          hasNext = true;
          break;
        }
        next = next.nextElementSibling;
      }
      if (!hasPrev || !hasNext) {
        sep.classList.add("action-overflow-hidden");
      }
    }
  }

  private bindHeaderEvents() {
    this.headerElement.querySelector("#btn-find-text")?.addEventListener("click", () => {
      window.dispatchEvent(new Event("open-document-search"));
    });
    this.headerElement.querySelector("#btn-about")?.addEventListener("click", () => {
      window.dispatchEvent(new CustomEvent("open-about"));
    });

    const saveCurrent = async () => {
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
    };

    const fileMenuBtn = this.headerElement.querySelector<HTMLButtonElement>("#btn-file-menu");
    const openFileMenu = (event: MouseEvent) => {
      const hasDoc = editorState.doc !== null;
      showContextMenu(event, "File", [
        { label: `${STRINGS.menu.open} (${STRINGS.menu.openShortcut})`, icon: FolderOpen, run: () => guardedPickPdf() },
        { label: `${STRINGS.menu.save} (${STRINGS.menu.saveShortcut})`, icon: Save, disabled: !hasDoc, run: saveCurrent },
        { label: `${STRINGS.menu.saveAs} (${STRINGS.menu.saveAsShortcut})`, icon: Download, disabled: !hasDoc, run: () => this.handleSaveAs() },
        { label: STRINGS.menu.exportPrint, icon: Printer, disabled: !hasDoc, run: () => { window.dispatchEvent(new CustomEvent("open-export-print")); } },
        { label: STRINGS.menu.metadata, icon: Info, disabled: !hasDoc, run: () => { window.dispatchEvent(new CustomEvent("open-metadata")); } },
      ]);
    };
    fileMenuBtn?.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      openFileMenu(event);
    });
    fileMenuBtn?.addEventListener("click", (event) => {
      if (event.detail === 0) openFileMenu(event);
    });

    this.headerElement.querySelector("#btn-open")?.addEventListener("click", () => {
      void guardedPickPdf();
    });

    this.headerElement.querySelector("#btn-save")?.addEventListener("click", () => {
      void saveCurrent();
    });

    this.headerElement.querySelector("#btn-save-as")?.addEventListener("click", () => {
      void this.handleSaveAs();
    });

    this.headerElement.querySelector("#btn-rename-doc")?.addEventListener("click", () => {
      this.startInlineRename();
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

    this.headerElement.querySelector("#btn-fit-width")?.addEventListener("click", () => {
      editorState.requestFitWidth();
    });

    this.headerElement.querySelector("#btn-fit-page")?.addEventListener("click", () => {
      editorState.requestFitPage();
    });

    this.headerElement.querySelector("#btn-toggle-properties")?.addEventListener("click", () => {
      editorState.togglePropertiesCollapsed();
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

    const rightOverflowBtn = this.headerElement.querySelector<HTMLButtonElement>("#btn-header-right-menu");
    const openRightOverflowMenu = (event: MouseEvent) => {
      const propsCollapsed = editorState.propertiesCollapsed;
      showContextMenu(event, "View & Tools", [
        { label: `${STRINGS.viewModes.continuous}${editorState.viewMode === "continuous" ? " ✓" : ""}`, icon: PanelsTopLeft, run: () => editorState.setViewMode("continuous") },
        { label: `${STRINGS.viewModes.single}${editorState.viewMode === "single" ? " ✓" : ""}`, icon: RectangleVertical, run: () => editorState.setViewMode("single") },
        { label: `${STRINGS.viewModes.spread}${editorState.viewMode === "spread" ? " ✓" : ""}`, icon: Columns2, run: () => editorState.setViewMode("spread") },
        { label: `${STRINGS.viewModes.grid}${editorState.viewMode === "grid" ? " ✓" : ""}`, icon: Grid2X2, run: () => editorState.setViewMode("grid") },
        { label: STRINGS.viewModes.fitWidth, icon: MoveHorizontal, run: () => editorState.requestFitWidth() },
        { label: STRINGS.viewModes.fitPage, icon: Maximize2, run: () => editorState.requestFitPage() },
        { label: propsCollapsed ? "Show Properties panel" : "Hide Properties panel", icon: propsCollapsed ? PanelRightOpen : PanelRightClose, run: () => editorState.togglePropertiesCollapsed() },
        { label: `${STRINGS.menu.shortcuts} (?)`, icon: Keyboard, run: () => { window.dispatchEvent(new CustomEvent("open-shortcuts")); } },
        { label: editorState.theme === "dark" ? "Switch to Light theme" : "Switch to Dark theme", icon: editorState.theme === "dark" ? Sun : Moon, run: () => editorState.toggleTheme() },
      ]);
    };
    rightOverflowBtn?.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      openRightOverflowMenu(event);
    });
    rightOverflowBtn?.addEventListener("click", (event) => {
      if (event.detail === 0) openRightOverflowMenu(event);
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
        defaultPath: editorState.doc?.file_path ?? editorState.doc?.file_name,
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

  private startInlineRename() {
    const doc = editorState.doc;
    const badge = this.headerElement.querySelector<HTMLButtonElement>("#btn-rename-doc");
    const container = badge?.parentElement;
    if (!doc || !badge || !container || this.isRenamingDoc) return;

    this.isRenamingDoc = true;
    const badgeRect = badge.getBoundingClientRect();
    const oldPath = doc.file_path;
    const oldName = doc.file_name;

    const input = document.createElement("input");
    input.type = "text";
    input.className = "doc-title-rename-input";
    input.value = oldName;
    input.style.width = `${Math.max(80, Math.round(badgeRect.width))}px`;
    input.style.height = `${Math.max(24, Math.round(badgeRect.height))}px`;
    input.setAttribute("aria-label", "Document name");

    container.replaceChildren(input);
    input.focus();
    const dotIndex = oldName.toLowerCase().endsWith(".pdf") ? oldName.length - 4 : oldName.length;
    input.setSelectionRange(0, Math.max(0, dotIndex));

    let finished = false;
    const finish = async (commit: boolean) => {
      if (finished) return;
      finished = true;
      const nextRaw = input.value.trim();
      const restored = async () => {
        this.isRenamingDoc = false;
        this.lastHeaderKey = "";
        this.renderHeader();
      };

      if (!commit || !nextRaw || nextRaw === oldName) {
        await restored();
        return;
      }

      input.disabled = true;
      try {
        const updated = await Backend.renameDocument(nextRaw);
        this.isRenamingDoc = false;
        this.lastHeaderKey = "";
        if (oldPath && updated.file_path && oldPath !== updated.file_path) {
          editorState.replaceRecentFile(oldPath, updated.file_path);
        }
        editorState.updateDocument(updated);
        toast.show({ message: `Renamed to ${updated.file_name}`, type: "success", durationMs: 2200 });
      } catch (err: any) {
        toast.show({ message: String(err), type: "error" });
        await restored();
      }
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        void finish(false);
      }
    });
    input.addEventListener("blur", () => {
      void finish(true);
    });
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

    const overflowBtn = this.actionToolbarElement.querySelector<HTMLButtonElement>("#btn-action-overflow");
    const openActionOverflow = (event: MouseEvent) => {
      if (this.overflowedActionButtons.length === 0) return;
      showContextMenu(
        event,
        "More Tools",
        this.overflowedActionButtons.map((btn) => ({
          label: `${btn.getAttribute("aria-label") || btn.title || "Tool"}${btn.classList.contains("active") ? " ✓" : ""}`,
          destructive: btn.classList.contains("text-destructive"),
          run: () => {
            btn.click();
          },
        }))
      );
    };
    overflowBtn?.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      openActionOverflow(event);
    });
    overflowBtn?.addEventListener("click", (event) => {
      if (event.detail === 0) openActionOverflow(event);
    });
  }
}
