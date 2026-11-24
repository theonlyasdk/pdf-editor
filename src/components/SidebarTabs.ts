import { invoke, isTauri } from "@tauri-apps/api/core";
import { ChevronDown, ChevronRight, Layers, ListTree, Lock, MessageSquareText } from "lucide";
import { STRINGS } from "../i18n/strings";
import { Backend } from "../ipc/backend";
import { editorState } from "../state/editorState";
import { AnnotationDto, OutlineItem, SidebarTab } from "../types/editor";
import { jumpToPage } from "./EditorContextMenu";
import { ThumbnailRailView } from "./ThumbnailRail";
import { icon } from "./ui/icon";

const ANNOT_TYPE_LABELS: Record<string, string> = {
  freeText: "Free Text",
  stickyNote: "Sticky Note",
  highlight: "Highlight",
  underline: "Underline",
  strikeout: "Strikethrough",
  squiggly: "Squiggly",
  pen: "Pen",
  highlighter: "Highlighter",
  rectangle: "Rectangle",
  circle: "Ellipse",
  line: "Line",
  arrow: "Arrow",
  stamp: "Stamp",
  image: "Signature / Image",
};

function formatAnnotType(type: string): string {
  return ANNOT_TYPE_LABELS[type] ?? type;
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
  private tabButtons: Map<SidebarTab, HTMLButtonElement> = new Map();
  private thumbnailsPanel: HTMLElement;
  private outlinePanel: HTMLElement;
  private annotationsPanel: HTMLElement;

  private outlineVersion = -1;
  private outlineItems: OutlineItem[] = [];
  private outlineLoading = false;
  private outlineError: string | null = null;
  private collapsedNodes: Set<string> = new Set();

  private annotTypeFilter = "all";
  private annotAuthorFilter = "all";
  private lastRenderKey = "";

  constructor(element: HTMLElement) {
    this.element = element;
    this.element.className = "thumbnail-rail";

    const tablist = document.createElement("div");
    tablist.className = "sidebar-tablist";
    tablist.setAttribute("role", "tablist");
    tablist.setAttribute("aria-label", "Sidebar views");

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
      btn.dataset.tab = tab.id;
      btn.innerHTML = `${tab.iconHtml}<span>${tab.label}</span>`;
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

    this.element.replaceChildren(tablist, this.thumbnailsPanel, this.outlinePanel, this.annotationsPanel);
    new ThumbnailRailView(this.thumbnailsPanel);

    this.render();
    editorState.subscribe(() => this.render());
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
      this.outlineItems = [];
      this.outlineError = null;
      this.collapsedNodes.clear();
      this.annotTypeFilter = "all";
      this.annotAuthorFilter = "all";
      return;
    }

    this.element.style.display = "flex";
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

    this.thumbnailsPanel.hidden = activeTab !== "thumbnails";
    this.outlinePanel.hidden = activeTab !== "outline";
    this.annotationsPanel.hidden = activeTab !== "annotations";

    if (activeTab === "outline") {
      if (this.outlineVersion !== editorState.documentVersion && !this.outlineLoading) {
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
    this.outlineLoading = true;
    this.outlineError = null;
    this.renderOutline();

    try {
      const items = await fetchDocumentOutline();
      if (editorState.documentVersion !== targetVersion) return;
      this.outlineVersion = targetVersion;
      this.outlineItems = items;
    } catch (err) {
      if (editorState.documentVersion !== targetVersion) return;
      this.outlineVersion = targetVersion;
      this.outlineItems = [];
      this.outlineError = String(err);
    } finally {
      this.outlineLoading = false;
      if (editorState.activeSidebarTab === "outline") {
        this.renderOutline();
      }
    }
  }

  private renderOutline() {
    if (this.outlineLoading) {
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
    if (this.outlineItems.length === 0) {
      this.outlinePanel.innerHTML = `<div class="sidebar-empty">${STRINGS.sidebar.noOutline}</div>`;
      return;
    }

    const header = document.createElement("div");
    header.className = "rail-header";
    header.innerHTML = `<div class="rail-tools"><span class="font-semibold">Bookmarks</span></div>`;

    const treeWrap = document.createElement("div");
    treeWrap.className = "sidebar-scroll-list";
    treeWrap.appendChild(this.buildOutlineList(this.outlineItems, "root"));

    this.outlinePanel.replaceChildren(header, treeWrap);
  }

  private buildOutlineList(items: OutlineItem[], prefix: string): HTMLUListElement {
    const ul = document.createElement("ul");
    ul.className = "outline-list";

    items.forEach((item, idx) => {
      const nodeKey = `${prefix}.${idx}`;
      const li = document.createElement("li");
      li.className = "outline-node";

      const row = document.createElement("div");
      row.className = "outline-item-row";

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

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "outline-item-btn";
      btn.disabled = item.page_index === null || item.page_index === undefined;
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

      row.appendChild(btn);
      li.appendChild(row);

      if (hasChildren && !isCollapsed) {
        li.appendChild(this.buildOutlineList(item.children, nodeKey));
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
        pageBadge.textContent = `p.${annot.page_index + 1}`;

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
