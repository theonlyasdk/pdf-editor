import { invoke, isTauri } from "@tauri-apps/api/core";
import { ChevronDown, ChevronRight, Download, FileText, Layers, ListTree, Lock, MessageSquareText, Pencil, Plus, Trash2 } from "lucide";
import { STRINGS } from "../i18n/strings";
import { Backend } from "../ipc/backend";
import { editorState } from "../state/editorState";
import { AnnotationDto, OutlineItem, SidebarTab } from "../types/editor";
import { exportAnnotationsToFile, formatAnnotTypeLabel } from "./annotationExport";
import { jumpToPage } from "./EditorContextMenu";
import { ThumbnailRailView } from "./ThumbnailRail";
import { toast } from "./Toast";
import { icon } from "./ui/icon";

function formatAnnotType(type: string): string {
  return formatAnnotTypeLabel(type);
}

async function fetchDocumentOutline(): Promise<OutlineItem[]> {
  const maybeBackend = Backend as { getDocumentOutline?: () => Promise<OutlineItem[]> };
  if (typeof maybeBackend.getDocumentOutline === "function") {
    return maybeBackend.getDocumentOutline();
  }
  if (isTauri()) {
    return invoke<OutlineItem[]>("get_document_outline");
  }
  return [];
}

export class SidebarTabsView {
  private element: HTMLElement;
  private tablist: HTMLElement;
  private tabButtons: Map<SidebarTab, HTMLButtonElement> = new Map();
  private thumbnailsPanel: HTMLElement;
  private outlinePanel: HTMLElement;
  private annotationsPanel: HTMLElement;

  private outlineVersion = -1;
  private outlineRasterVersion = -1;
  private outlineItems: OutlineItem[] = [];
  private outlineLoading = false;
  private outlineError: string | null = null;
  private collapsedNodes: Set<string> = new Set();
  private editingPathKey: string | null = null;
  private dragSourcePath: number[] | null = null;

  private annotTypeFilter = "all";
  private annotAuthorFilter = "all";
  private lastRenderKey = "";
  private resizeObserver: ResizeObserver | null = null;

  constructor(element: HTMLElement) {
    this.element = element;
    this.element.className = "thumbnail-rail";

    const tablist = document.createElement("div");
    tablist.className = "sidebar-tablist";
    tablist.setAttribute("role", "tablist");
    tablist.setAttribute("aria-label", "Sidebar views");
    this.tablist = tablist;

    const tabs: Array<{ id: SidebarTab; label: string; iconHtml: string }> = [
      { id: "thumbnails", label: STRINGS.sidebar.thumbnails, iconHtml: icon(Layers, 14) },
      { id: "outline", label: STRINGS.sidebar.outline, iconHtml: icon(ListTree, 14) },
      { id: "annotations", label: STRINGS.sidebar.annotations, iconHtml: icon(MessageSquareText, 14) },
    ];

    for (const tab of tabs) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sidebar-tab-btn";
      btn.id = `sidebar-tab-${tab.id}`;
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-controls", `sidebar-panel-${tab.id}`);
      btn.setAttribute("aria-label", tab.label);
      btn.title = tab.label;
      btn.dataset.tab = tab.id;
      btn.innerHTML = `${tab.iconHtml}<span class="sidebar-tab-label">${tab.label}</span>`;
      if (tab.id === "annotations") {
        const badge = document.createElement("span");
        badge.className = "sidebar-tab-count";
        badge.hidden = true;
        btn.appendChild(badge);
      }
      btn.addEventListener("click", () => editorState.setSidebarTab(tab.id));
      btn.addEventListener("keydown", (e) => this.handleTabKeydown(e, tab.id));
      this.tabButtons.set(tab.id, btn);
      tablist.appendChild(btn);
    }

    this.thumbnailsPanel = this.createPanel("thumbnails");
    this.outlinePanel = this.createPanel("outline");
    this.annotationsPanel = this.createPanel("annotations");

    const resizer = document.createElement("div");
    resizer.className = "sidebar-resizer";
    resizer.setAttribute("role", "separator");
    resizer.setAttribute("aria-orientation", "vertical");
    resizer.setAttribute("aria-label", "Resize sidebar");
    resizer.tabIndex = 0;

    this.element.replaceChildren(tablist, this.thumbnailsPanel, this.outlinePanel, this.annotationsPanel, resizer);
    new ThumbnailRailView(this.thumbnailsPanel);
    this.bindResizer(resizer);

    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.syncTabLabels());
      this.resizeObserver.observe(this.element);
    }

    this.render();
    editorState.subscribe(() => this.render());
    window.addEventListener("add-bookmark-current-page", () => {
      if (editorState.doc) void this.addBookmarkAtCurrentPage();
    });
  }

  private syncTabLabels() {
    const available = this.tablist.clientWidth;
    if (available <= 0) return;

    const wasCompact = this.tablist.classList.contains("compact-tabs");
    if (wasCompact) this.tablist.classList.remove("compact-tabs");

    let needed = 0;
    for (const btn of this.tabButtons.values()) {
      const label = btn.querySelector<HTMLElement>(".sidebar-tab-label");
      const badge = btn.querySelector<HTMLElement>(".sidebar-tab-count:not([hidden])");
      // icon (14) + horizontal padding (12) + label + badge + gaps
      needed += 14 + 12 + (label ? Math.ceil(label.getBoundingClientRect().width) + 4 : 0) + (badge ? Math.ceil(badge.getBoundingClientRect().width) + 4 : 0);
    }

    this.tablist.classList.toggle("compact-tabs", available < needed);
  }

  private bindResizer(resizer: HTMLElement) {
    let drag: { pointerId: number; startX: number; startWidth: number } | null = null;
    resizer.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      resizer.setPointerCapture(e.pointerId);
      drag = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startWidth: this.element.getBoundingClientRect().width || editorState.sidebarWidth,
      };
      this.element.classList.add("resizing");
    });
    resizer.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      const next = Math.max(160, Math.min(440, Math.round(drag.startWidth + (e.clientX - drag.startX))));
      this.element.style.width = `${next}px`;
      editorState.setSidebarWidth(next, false);
    });
    const finish = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      const next = Math.max(160, Math.min(440, Math.round(drag.startWidth + (e.clientX - drag.startX))));
      drag = null;
      this.element.classList.remove("resizing");
      editorState.setSidebarWidth(next, true);
    };
    resizer.addEventListener("pointerup", finish);
    resizer.addEventListener("pointercancel", finish);
    resizer.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 24 : 10;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        editorState.setSidebarWidth(editorState.sidebarWidth + step);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        editorState.setSidebarWidth(editorState.sidebarWidth - step);
      }
    });
  }

  private createPanel(id: SidebarTab): HTMLElement {
    const panel = document.createElement("div");
    panel.className = "sidebar-tab-panel";
    panel.id = `sidebar-panel-${id}`;
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", `sidebar-tab-${id}`);
    panel.dataset.tab = id;
    return panel;
  }

  private handleTabKeydown(e: KeyboardEvent, current: SidebarTab) {
    const order: SidebarTab[] = ["thumbnails", "outline", "annotations"];
    const idx = order.indexOf(current);
    let next: SidebarTab | undefined;
    if (e.key === "ArrowRight") next = order[(idx + 1) % order.length];
    else if (e.key === "ArrowLeft") next = order[(idx - 1 + order.length) % order.length];
    else if (e.key === "Home") next = order[0];
    else if (e.key === "End") next = order[order.length - 1];
    if (next) {
      e.preventDefault();
      editorState.setSidebarTab(next);
      this.tabButtons.get(next)?.focus();
    }
  }

  private render() {
    if (!editorState.doc) {
      this.element.style.display = "none";
      this.outlineVersion = -1;
      this.outlineRasterVersion = -1;
      this.outlineItems = [];
      this.outlineError = null;
      this.editingPathKey = null;
      this.collapsedNodes.clear();
      this.annotTypeFilter = "all";
      this.annotAuthorFilter = "all";
      return;
    }

    this.element.style.display = "flex";
    this.element.style.width = `${editorState.sidebarWidth}px`;
    const activeTab = editorState.activeSidebarTab;
    const annotations = editorState.doc.annotations ?? [];

    for (const [id, btn] of this.tabButtons) {
      const selected = id === activeTab;
      btn.classList.toggle("active", selected);
      btn.setAttribute("aria-selected", String(selected));
      btn.tabIndex = selected ? 0 : -1;
      if (id === "annotations") {
        const badge = btn.querySelector<HTMLElement>(".sidebar-tab-count");
        if (badge) {
          badge.hidden = annotations.length === 0;
          badge.textContent = String(annotations.length);
        }
      }
    }
    this.syncTabLabels();

    this.thumbnailsPanel.hidden = activeTab !== "thumbnails";
    this.outlinePanel.hidden = activeTab !== "outline";
    this.annotationsPanel.hidden = activeTab !== "annotations";

    if (activeTab === "outline") {
      if ((this.outlineVersion !== editorState.documentVersion || this.outlineRasterVersion !== editorState.rasterVersion) && !this.outlineLoading) {
        void this.loadOutline();
      } else {
        this.renderOutline();
      }
    } else if (activeTab === "annotations") {
      const key = `${editorState.documentVersion}:${editorState.rasterVersion}:${editorState.selectedAnnotationId ?? ""}:${annotations.length}:${this.annotTypeFilter}:${this.annotAuthorFilter}`;
      if (key !== this.lastRenderKey) {
        this.lastRenderKey = key;
        this.renderAnnotations(annotations);
      }
    }
  }

  private async loadOutline() {
    const targetVersion = editorState.documentVersion;
    const targetRaster = editorState.rasterVersion;
    this.outlineLoading = true;
    this.outlineError = null;
    this.renderOutline();

    try {
      const items = await fetchDocumentOutline();
      if (editorState.documentVersion !== targetVersion) return;
      this.outlineVersion = targetVersion;
      this.outlineRasterVersion = targetRaster;
      this.outlineItems = items;
    } catch (err) {
      if (editorState.documentVersion !== targetVersion) return;
      this.outlineVersion = targetVersion;
      this.outlineRasterVersion = targetRaster;
      this.outlineItems = [];
      this.outlineError = String(err);
    } finally {
      this.outlineLoading = false;
      if (editorState.activeSidebarTab === "outline") {
        this.renderOutline();
      }
    }
  }

  private cloneOutline(items: OutlineItem[]): OutlineItem[] {
    return items.map((item) => ({
      title: item.title,
      page_index: item.page_index,
      children: this.cloneOutline(item.children || []),
    }));
  }

  private getAtPath(items: OutlineItem[], path: number[]): OutlineItem | null {
    let cur: OutlineItem[] = items;
    let node: OutlineItem | undefined;
    for (const idx of path) {
      node = cur[idx];
      if (!node) return null;
      cur = node.children;
    }
    return node ?? null;
  }

  private removeAtPath(items: OutlineItem[], path: number[]): OutlineItem | null {
    if (path.length === 0) return null;
    if (path.length === 1) {
      const [removed] = items.splice(path[0], 1);
      return removed ?? null;
    }
    const parent = this.getAtPath(items, path.slice(0, -1));
    if (!parent) return null;
    const [removed] = parent.children.splice(path[path.length - 1], 1);
    return removed ?? null;
  }

  private async commitOutline(nextItems: OutlineItem[]) {
    const docVer = editorState.documentVersion;
    this.outlineItems = nextItems;
    this.renderOutline();
    try {
      const updated = await Backend.updateDocumentOutline(nextItems);
      if (editorState.documentVersion === docVer) {
        this.outlineRasterVersion = editorState.rasterVersion + 1;
        editorState.updateDocument(updated);
        this.outlineRasterVersion = editorState.rasterVersion;
      }
    } catch (err) {
      toast.show({ message: `Could not update bookmarks: ${String(err)}`, type: "error" });
    }
  }

  private async addBookmarkAtCurrentPage(parentPath?: number[]) {
    if (!editorState.doc) return;
    const page = editorState.currentPage;
    const next = this.cloneOutline(this.outlineItems);
    const newItem: OutlineItem = {
      title: `Page ${page + 1}`,
      page_index: page,
      children: [],
    };
    let newPath: number[];
    if (parentPath && parentPath.length > 0) {
      const parent = this.getAtPath(next, parentPath);
      if (!parent) return;
      parent.children.push(newItem);
      this.collapsedNodes.delete(`root.${parentPath.join(".")}`);
      newPath = [...parentPath, parent.children.length - 1];
    } else {
      next.push(newItem);
      newPath = [next.length - 1];
    }
    this.editingPathKey = `root.${newPath.join(".")}`;
    await this.commitOutline(next);
  }

  private renderOutline() {
    if (this.outlineLoading && this.outlineItems.length === 0) {
      this.outlinePanel.innerHTML = `<div class="sidebar-empty">Loading outline...</div>`;
      return;
    }
    if (this.outlineError) {
      const errEl = document.createElement("div");
      errEl.className = "sidebar-empty text-destructive";
      errEl.textContent = this.outlineError;
      this.outlinePanel.replaceChildren(errEl);
      return;
    }

    const header = document.createElement("div");
    header.className = "rail-header";
    const tools = document.createElement("div");
    tools.className = "rail-tools";
    const titleSpan = document.createElement("span");
    titleSpan.className = "font-semibold";
    titleSpan.textContent = "Bookmarks";
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "ui-button ui-button--tool";
    addBtn.title = "Add bookmark at current page (Ctrl+Shift+B)";
    addBtn.setAttribute("aria-label", "Add bookmark at current page");
    addBtn.innerHTML = icon(Plus, 14);
    addBtn.addEventListener("click", () => void this.addBookmarkAtCurrentPage());
    tools.append(titleSpan, addBtn);
    header.appendChild(tools);

    if (this.outlineItems.length === 0) {
      const emptyWrap = document.createElement("div");
      emptyWrap.className = "outline-empty-add";
      const msg = document.createElement("div");
      msg.className = "sidebar-empty";
      msg.style.padding = "0";
      msg.textContent = STRINGS.sidebar.noOutline;
      const cta = document.createElement("button");
      cta.type = "button";
      cta.className = "ui-button ui-button--outline ui-button--sm";
      cta.textContent = "Add bookmark";
      cta.addEventListener("click", () => void this.addBookmarkAtCurrentPage());
      emptyWrap.append(msg, cta);
      this.outlinePanel.replaceChildren(header, emptyWrap);
      return;
    }

    const treeWrap = document.createElement("div");
    treeWrap.className = "sidebar-scroll-list";
    treeWrap.appendChild(this.buildOutlineList(this.outlineItems, "root", []));

    this.outlinePanel.replaceChildren(header, treeWrap);
  }

  private buildOutlineList(items: OutlineItem[], prefix: string, parentPath: number[]): HTMLUListElement {
    const ul = document.createElement("ul");
    ul.className = "outline-list";

    items.forEach((item, idx) => {
      const itemPath = [...parentPath, idx];
      const nodeKey = `${prefix}.${idx}`;
      const li = document.createElement("li");
      li.className = "outline-node";

      const row = document.createElement("div");
      row.className = "outline-item-row";
      row.draggable = this.editingPathKey !== nodeKey;

      row.addEventListener("dragstart", (e) => {
        this.dragSourcePath = itemPath;
        e.dataTransfer?.setData("text/plain", nodeKey);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      });
      row.addEventListener("dragover", (e) => {
        if (!this.dragSourcePath) return;
        e.preventDefault();
        const rect = row.getBoundingClientRect();
        const topHalf = e.clientY < rect.top + rect.height / 2;
        row.classList.toggle("drag-over-top", topHalf);
        row.classList.toggle("drag-over-bottom", !topHalf);
      });
      row.addEventListener("dragleave", () => {
        row.classList.remove("drag-over-top", "drag-over-bottom");
      });
      row.addEventListener("drop", (e) => {
        e.preventDefault();
        row.classList.remove("drag-over-top", "drag-over-bottom");
        const src = this.dragSourcePath;
        this.dragSourcePath = null;
        if (!src) return;
        const srcKey = src.join(".");
        const dstKey = itemPath.join(".");
        if (srcKey === dstKey || dstKey.startsWith(`${srcKey}.`)) return;

        const rect = row.getBoundingClientRect();
        const insertBefore = e.clientY < rect.top + rect.height / 2;
        const next = this.cloneOutline(this.outlineItems);
        const moved = this.removeAtPath(next, src);
        if (!moved) return;

        // Adjust target index if same parent and source was before target
        const targetParentPath = itemPath.slice(0, -1);
        let targetIdx = itemPath[itemPath.length - 1];
        if (
          src.length === itemPath.length &&
          src.slice(0, -1).every((v, i) => v === targetParentPath[i]) &&
          src[src.length - 1] < targetIdx
        ) {
          targetIdx--;
        }
        const insertIdx = insertBefore ? targetIdx : targetIdx + 1;
        if (targetParentPath.length === 0) {
          next.splice(Math.max(0, Math.min(next.length, insertIdx)), 0, moved);
        } else {
          const parent = this.getAtPath(next, targetParentPath);
          if (parent) {
            parent.children.splice(Math.max(0, Math.min(parent.children.length, insertIdx)), 0, moved);
          }
        }
        void this.commitOutline(next);
      });

      const hasChildren = item.children && item.children.length > 0;
      const isCollapsed = this.collapsedNodes.has(nodeKey);

      if (hasChildren) {
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "outline-toggle";
        toggle.setAttribute("aria-label", isCollapsed ? "Expand section" : "Collapse section");
        toggle.setAttribute("aria-expanded", String(!isCollapsed));
        toggle.innerHTML = isCollapsed ? icon(ChevronRight, 13) : icon(ChevronDown, 13);
        toggle.addEventListener("click", (e) => {
          e.stopPropagation();
          if (this.collapsedNodes.has(nodeKey)) this.collapsedNodes.delete(nodeKey);
          else this.collapsedNodes.add(nodeKey);
          this.renderOutline();
        });
        row.appendChild(toggle);
      } else {
        const spacer = document.createElement("span");
        spacer.className = "outline-toggle-spacer";
        row.appendChild(spacer);
      }

      if (this.editingPathKey === nodeKey) {
        const input = document.createElement("input");
        input.type = "text";
        input.className = "ui-input outline-rename-input";
        input.value = item.title;
        let done = false;
        const finishRename = (commit: boolean) => {
          if (done) return;
          done = true;
          this.editingPathKey = null;
          const trimmed = input.value.trim();
          if (commit && trimmed && trimmed !== item.title) {
            const next = this.cloneOutline(this.outlineItems);
            const target = this.getAtPath(next, itemPath);
            if (target) target.title = trimmed;
            void this.commitOutline(next);
          } else {
            this.renderOutline();
          }
        };
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            finishRename(true);
          } else if (e.key === "Escape") {
            e.preventDefault();
            finishRename(false);
          }
        });
        input.addEventListener("blur", () => finishRename(true));
        row.appendChild(input);
        queueMicrotask(() => {
          input.focus();
          input.select();
        });
      } else {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "outline-item-btn";
        btn.title = item.title;

        const titleSpan = document.createElement("span");
        titleSpan.className = "outline-item-title";
        titleSpan.textContent = item.title || "(Untitled)";
        btn.appendChild(titleSpan);

        if (item.page_index !== null && item.page_index !== undefined) {
          const pageSpan = document.createElement("span");
          pageSpan.className = "outline-item-page";
          pageSpan.textContent = String(item.page_index + 1);
          btn.appendChild(pageSpan);

          btn.addEventListener("click", () => {
            if (item.page_index !== null && editorState.doc && item.page_index >= 0 && item.page_index < editorState.doc.page_count) {
              jumpToPage(item.page_index);
            }
          });
        }
        btn.addEventListener("dblclick", (e) => {
          e.stopPropagation();
          this.editingPathKey = nodeKey;
          this.renderOutline();
        });

        row.appendChild(btn);

        const actions = document.createElement("div");
        actions.className = "outline-item-actions";

        const renameBtn = document.createElement("button");
        renameBtn.type = "button";
        renameBtn.className = "outline-action-btn";
        renameBtn.title = "Rename bookmark";
        renameBtn.setAttribute("aria-label", "Rename bookmark");
        renameBtn.innerHTML = icon(Pencil, 12);
        renameBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          this.editingPathKey = nodeKey;
          this.renderOutline();
        });

        const addChildBtn = document.createElement("button");
        addChildBtn.type = "button";
        addChildBtn.className = "outline-action-btn";
        addChildBtn.title = "Add child bookmark at current page";
        addChildBtn.setAttribute("aria-label", "Add child bookmark");
        addChildBtn.innerHTML = icon(Plus, 12);
        addChildBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          void this.addBookmarkAtCurrentPage(itemPath);
        });

        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "outline-action-btn destructive";
        delBtn.title = "Delete bookmark";
        delBtn.setAttribute("aria-label", "Delete bookmark");
        delBtn.innerHTML = icon(Trash2, 12);
        delBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          const next = this.cloneOutline(this.outlineItems);
          this.removeAtPath(next, itemPath);
          void this.commitOutline(next);
        });

        actions.append(renameBtn, addChildBtn, delBtn);
        row.appendChild(actions);
      }

      li.appendChild(row);

      if (hasChildren && !isCollapsed) {
        li.appendChild(this.buildOutlineList(item.children, nodeKey, itemPath));
      }

      ul.appendChild(li);
    });

    return ul;
  }

  private renderAnnotations(annotations: AnnotationDto[]) {
    const types = Array.from(new Set(annotations.map((a) => a.annot_type))).sort();
    const authors = Array.from(new Set(annotations.map((a) => a.author || "Unknown"))).sort();

    if (this.annotTypeFilter !== "all" && !types.includes(this.annotTypeFilter)) {
      this.annotTypeFilter = "all";
    }
    if (this.annotAuthorFilter !== "all" && !authors.includes(this.annotAuthorFilter)) {
      this.annotAuthorFilter = "all";
    }

    const filtered = annotations.filter((a) => {
      if (this.annotTypeFilter !== "all" && a.annot_type !== this.annotTypeFilter) return false;
      if (this.annotAuthorFilter !== "all" && (a.author || "Unknown") !== this.annotAuthorFilter) return false;
      return true;
    });

    const header = document.createElement("div");
    header.className = "rail-header";

    const toolsRow = document.createElement("div");
    toolsRow.className = "rail-tools";
    toolsRow.innerHTML = `<span class="font-semibold">Annotations <span class="rail-page-count">${filtered.length}/${annotations.length}</span></span>`;

    const exportGroup = document.createElement("div");
    exportGroup.className = "flex items-center gap-1";

    const exportMdBtn = document.createElement("button");
    exportMdBtn.type = "button";
    exportMdBtn.className = "ui-button ui-button--tool";
    exportMdBtn.title = "Export annotations as Markdown";
    exportMdBtn.setAttribute("aria-label", "Export annotations as Markdown");
    exportMdBtn.disabled = filtered.length === 0;
    exportMdBtn.innerHTML = `${icon(FileText, 13)}<span>MD</span>`;
    exportMdBtn.addEventListener("click", async () => {
      const doc = editorState.doc;
      if (!doc) return;
      try {
        const labels = doc.pages.map((p) => p.label);
        const saved = await exportAnnotationsToFile("markdown", filtered, doc.file_name, labels);
        if (saved) toast.show({ message: "Exported annotations as Markdown.", type: "success" });
      } catch (err) {
        toast.show({ message: `Export failed: ${String(err)}`, type: "error" });
      }
    });

    const exportCsvBtn = document.createElement("button");
    exportCsvBtn.type = "button";
    exportCsvBtn.className = "ui-button ui-button--tool";
    exportCsvBtn.title = "Export annotations as CSV";
    exportCsvBtn.setAttribute("aria-label", "Export annotations as CSV");
    exportCsvBtn.disabled = filtered.length === 0;
    exportCsvBtn.innerHTML = `${icon(Download, 13)}<span>CSV</span>`;
    exportCsvBtn.addEventListener("click", async () => {
      const doc = editorState.doc;
      if (!doc) return;
      try {
        const labels = doc.pages.map((p) => p.label);
        const saved = await exportAnnotationsToFile("csv", filtered, doc.file_name, labels);
        if (saved) toast.show({ message: "Exported annotations as CSV.", type: "success" });
      } catch (err) {
        toast.show({ message: `Export failed: ${String(err)}`, type: "error" });
      }
    });

    exportGroup.append(exportMdBtn, exportCsvBtn);
    toolsRow.appendChild(exportGroup);
    header.appendChild(toolsRow);

    const filters = document.createElement("div");
    filters.className = "sidebar-annot-filters";

    const typeSelect = document.createElement("select");
    typeSelect.className = "ui-input";
    typeSelect.setAttribute("aria-label", "Filter annotations by type");
    typeSelect.append(new Option(STRINGS.sidebar.allTypes, "all"));
    for (const t of types) {
      typeSelect.append(new Option(formatAnnotType(t), t));
    }
    typeSelect.value = this.annotTypeFilter;
    typeSelect.addEventListener("change", () => {
      this.annotTypeFilter = typeSelect.value;
      this.lastRenderKey = "";
      this.render();
    });

    const authorSelect = document.createElement("select");
    authorSelect.className = "ui-input";
    authorSelect.setAttribute("aria-label", "Filter annotations by author");
    authorSelect.append(new Option(STRINGS.sidebar.allAuthors, "all"));
    for (const author of authors) {
      authorSelect.append(new Option(author, author));
    }
    authorSelect.value = this.annotAuthorFilter;
    authorSelect.addEventListener("change", () => {
      this.annotAuthorFilter = authorSelect.value;
      this.lastRenderKey = "";
      this.render();
    });

    filters.append(typeSelect, authorSelect);
    header.appendChild(filters);

    const listWrap = document.createElement("div");
    listWrap.className = "sidebar-scroll-list";

    if (annotations.length === 0) {
      listWrap.innerHTML = `<div class="sidebar-empty">${STRINGS.sidebar.noAnnotations}</div>`;
    } else if (filtered.length === 0) {
      listWrap.innerHTML = `<div class="sidebar-empty">No matching annotations.</div>`;
    } else {
      for (const annot of filtered) {
        const card = document.createElement("button");
        card.type = "button";
        card.className = `sidebar-annot-item ${editorState.selectedAnnotationId === annot.id ? "active" : ""}`;

        const top = document.createElement("div");
        top.className = "sidebar-annot-top";

        const typeWrap = document.createElement("span");
        typeWrap.className = "sidebar-annot-type";

        const swatch = document.createElement("span");
        swatch.className = "sidebar-annot-swatch";
        swatch.style.backgroundColor = annot.color || "#2563eb";
        typeWrap.appendChild(swatch);

        const typeText = document.createElement("span");
        typeText.textContent = formatAnnotType(annot.annot_type);
        typeWrap.appendChild(typeText);

        if (annot.locked) {
          const lockWrap = document.createElement("span");
          lockWrap.className = "sidebar-annot-lock";
          lockWrap.innerHTML = icon(Lock, 11);
          typeWrap.appendChild(lockWrap);
        }

        const pageBadge = document.createElement("span");
        pageBadge.className = "sidebar-annot-page";
        const pageLabel = editorState.doc?.pages[annot.page_index]?.label;
        pageBadge.textContent = pageLabel ? `p.${pageLabel}` : `p.${annot.page_index + 1}`;

        top.append(typeWrap, pageBadge);
        card.appendChild(top);

        const meta = document.createElement("div");
        meta.className = "sidebar-annot-meta";
        meta.textContent = annot.author || "Unknown";
        card.appendChild(meta);

        if (annot.text) {
          const snippet = document.createElement("div");
          snippet.className = "sidebar-annot-snippet";
          snippet.textContent = annot.text;
          card.appendChild(snippet);
        }

        card.addEventListener("click", () => {
          editorState.setTool("select");
          editorState.setCurrentPage(annot.page_index);
          editorState.selectAnnotation(annot.id);
          window.dispatchEvent(new CustomEvent("jump-to-page", { detail: { pageIndex: annot.page_index } }));
        });

        listWrap.appendChild(card);
      }
    }

    this.annotationsPanel.replaceChildren(header, listWrap);
  }
}
