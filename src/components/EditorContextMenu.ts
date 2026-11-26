import {
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Copy,
  Crop,
  FilePlus2,
  Hand,
  Hash,
  Info,
  Maximize2,
  MousePointer2,
  MoveHorizontal,
  RotateCcw,
  RotateCw,
  Scan,
  Search,
  Trash2,
  ZoomIn,
  ZoomOut,
  type IconNode,
} from "lucide";
import { STRINGS } from "../i18n/strings";
import { Backend } from "../ipc/backend";
import { editorState } from "../state/editorState";
import { toast } from "./Toast";
import { icon } from "./ui/icon";
import type { AnnotationDto, DocumentDto } from "../types/editor";

interface MenuAction {
  label: string;
  run: () => void | Promise<void>;
  disabled?: boolean;
  destructive?: boolean;
  color?: string;
  icon?: IconNode;
  separatorBefore?: boolean;
}

let closeOpenMenu: ((restore?: boolean) => void) | null = null;
let openMenuTrigger: HTMLElement | null = null;

export function showContextMenu(event: MouseEvent, title: string, actions: MenuAction[]) {
  event.preventDefault();
  const anchorEl =
    event.currentTarget instanceof HTMLElement
      ? event.currentTarget
      : ((event.target as Element | null)?.closest?.("button, [aria-haspopup]") as HTMLElement | null) ??
        (event.target as Element);
  const trigger = event.type !== "contextmenu" && anchorEl instanceof HTMLElement ? anchorEl : null;
  if (trigger && openMenuTrigger === trigger && closeOpenMenu) {
    closeOpenMenu(true);
    return;
  }
  closeOpenMenu?.();
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const menu = document.createElement("div");
  menu.className = "editor-context-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", title);
  const header = document.createElement("div");
  header.className = "context-menu-title";
  header.textContent = title;
  menu.appendChild(header);
  const listeners = new AbortController();
  const close = (restore = false) => {
    listeners.abort();
    menu.remove();
    closeOpenMenu = null;
    openMenuTrigger = null;
    if (restore && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  };
  closeOpenMenu = close;
  openMenuTrigger = trigger;

  let renderedCount = 0;
  for (const action of actions) {
    if (action.separatorBefore && renderedCount > 0) {
      const sep = document.createElement("div");
      sep.className = "context-menu-separator";
      sep.setAttribute("role", "separator");
      menu.appendChild(sep);
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "context-menu-item";
    button.setAttribute("role", "menuitem");
    button.disabled = Boolean(action.disabled);
    if (action.destructive) button.classList.add("text-destructive");
    if (action.icon) {
      const iconWrap = document.createElement("span");
      iconWrap.className = "context-menu-icon";
      iconWrap.innerHTML = icon(action.icon, 14);
      button.appendChild(iconWrap);
    }
    if (action.color) {
      const swatch = document.createElement("span");
      swatch.className = "context-menu-swatch";
      swatch.style.backgroundColor = action.color;
      button.appendChild(swatch);
    }
    button.append(action.label);
    button.addEventListener("click", async () => {
      close();
      try { await action.run(); }
      catch (error) { toast.show({ message: String(error), type: "error" }); }
    });
    menu.appendChild(button);
    renderedCount++;
  }

  document.body.appendChild(menu);
  const source = anchorEl.getBoundingClientRect();
  const anchorToButton = event.type !== "contextmenu" || (event.clientX === 0 && event.clientY === 0);
  const rawLeft = anchorToButton ? source.left : event.clientX;
  const fitsBelow = source.bottom + 4 + menu.offsetHeight <= innerHeight - 8;
  const rawTop = anchorToButton ? (fitsBelow ? source.bottom + 4 : source.top - menu.offsetHeight - 4) : event.clientY;
  menu.style.left = `${Math.max(8, Math.min(rawLeft, innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(rawTop, innerHeight - menu.offsetHeight - 8))}px`;
  const buttons = [...menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
  buttons[0]?.focus();
  menu.addEventListener("keydown", (key) => {
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (key.key === "Escape" || key.key === "Tab") {
      key.stopPropagation();
      if (key.key === "Escape") key.preventDefault();
      close(true);
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(key.key)) {
      key.preventDefault();
      const index = key.key === "Home" ? 0 : key.key === "End" ? buttons.length - 1
        : (current + (key.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[index]?.focus();
    }
  });
  window.addEventListener("pointerdown", (pointer) => {
    const target = pointer.target as Node | null;
    if (target && (menu.contains(target) || (trigger && trigger.contains(target)))) return;
    close();
  }, { signal: listeners.signal, capture: true });
  window.addEventListener("resize", () => close(), { signal: listeners.signal });
  window.addEventListener("blur", () => close(), { signal: listeners.signal });
}

export function showToolMenu(event: MouseEvent, page?: number, annotation?: AnnotationDto) {
  const tool = editorState.activeTool;
  const doc = editorState.doc;
  const cur = editorState.currentPage;
  const total = doc?.page_count ?? 0;
  const targetPage = page ?? cur;
  const actions: MenuAction[] = [];

  if (annotation) {
    actions.push({
      label: "Delete annotation",
      icon: Trash2,
      destructive: true,
      run: async () => {
        const updated = await Backend.deleteAnnotation(annotation.page_index, annotation.id);
        editorState.updateDocument(updated);
      },
    });
  }

  if (["pen", "highlighter", "rectangle", "circle", "line", "arrow", "freeText", "coverErase"].includes(tool)) {
    const key = tool === "coverErase" ? "coverColor" : "strokeColor";
    let first = true;
    for (const [label, color] of [["Black", "#252524"], ["Red", "#d53b42"], ["Blue", "#2563eb"], ["Yellow", "#ffe04a"], ["White", "#ffffff"]]) {
      actions.push({ label, color, separatorBefore: first, run: () => editorState.updateToolSettings({ [key]: color }) });
      first = false;
    }
  }
  if (["pen", "highlighter", "rectangle", "circle", "line", "arrow"].includes(tool)) {
    let first = true;
    for (const width of [2, 6, 12]) {
      actions.push({ label: `${width} pt stroke`, separatorBefore: first, run: () => editorState.updateToolSettings({ strokeWidth: width }) });
      first = false;
    }
  }
  if (tool === "crop") {
    actions.push({
      label: "Reset crop to full page",
      icon: Crop,
      separatorBefore: true,
      run: () => {
        editorState.initCropBoxForCurrentPage();
        editorState.notify();
      },
    });
  }

  if (doc) {
    actions.push(
      { label: "Previous page", icon: ChevronLeft, separatorBefore: true, disabled: cur <= 0, run: () => jumpToPage(cur - 1) },
      { label: "Next page", icon: ChevronRight, disabled: cur >= total - 1, run: () => jumpToPage(cur + 1) },
      { label: "First page", icon: ChevronsLeft, disabled: cur <= 0, run: () => jumpToPage(0) },
      { label: "Last page", icon: ChevronsRight, disabled: cur >= total - 1, run: () => jumpToPage(total - 1) },
      ...(page !== undefined && page !== cur
        ? [{ label: `Jump to page ${page + 1}`, icon: ArrowUpRight, run: () => jumpToPage(page) }]
        : []),
      { label: "Go to page...", icon: Hash, run: () => { window.dispatchEvent(new CustomEvent("open-page-jump")); } },
    );
  }

  actions.push(
    { label: "Zoom in", icon: ZoomIn, separatorBefore: true, run: () => editorState.zoomIn() },
    { label: "Zoom out", icon: ZoomOut, run: () => editorState.zoomOut() },
    { label: "Actual size (100%)", icon: Scan, disabled: Math.abs(editorState.zoom - 1) < 0.005, run: () => editorState.setZoom(1.0) },
    { label: "Fit width", icon: MoveHorizontal, disabled: !doc, run: () => editorState.requestFitWidth() },
    { label: "Fit page", icon: Maximize2, disabled: !doc, run: () => editorState.requestFitPage() },
  );

  if (doc) {
    const version = editorState.documentVersion;
    const rotate = async (deg: number) => {
      const updated = await Backend.rotatePages([targetPage], deg);
      if (editorState.documentVersion === version) editorState.updateDocument(updated);
    };
    actions.push(
      { label: "Rotate page left", icon: RotateCcw, separatorBefore: true, run: () => rotate(-90) },
      { label: "Rotate page right", icon: RotateCw, run: () => rotate(90) },
      { label: "Find in document", icon: Search, run: () => { window.dispatchEvent(new Event("open-document-search")); } },
      { label: "Document properties", icon: Info, run: () => { window.dispatchEvent(new CustomEvent("open-metadata")); } },
    );
  }

  actions.push(
    { label: "Select tool", icon: MousePointer2, separatorBefore: true, disabled: tool === "select", run: () => editorState.setTool("select") },
    { label: "Hand tool", icon: Hand, disabled: tool === "hand", run: () => editorState.setTool("hand") },
  );

  showContextMenu(event, STRINGS.tools[tool], actions);
}

export function jumpToPage(page: number) {
  editorState.setCurrentPage(page);
  window.dispatchEvent(new CustomEvent("jump-to-page", { detail: { pageIndex: page } }));
}

export function showPageMenu(event: MouseEvent, page: number) {
  const doc = editorState.doc;
  if (!doc) return;
  const targets = editorState.selectedPages.has(page) ? [...editorState.selectedPages].sort((a, b) => a - b) : [page];
  const apply = async (work: Promise<DocumentDto>) => {
    const version = editorState.documentVersion;
    const updated = await work;
    if (editorState.documentVersion === version) editorState.updateDocument(updated);
  };
  showContextMenu(event, targets.length === 1 ? `Page ${page + 1}` : `${targets.length} selected pages`, [
    { label: "Go to page", icon: ArrowUpRight, run: () => jumpToPage(page) },
    { label: "Rotate left", icon: RotateCcw, run: () => apply(Backend.rotatePages(targets, -90)) },
    { label: "Rotate right", icon: RotateCw, run: () => apply(Backend.rotatePages(targets, 90)) },
    { label: "Duplicate", icon: Copy, run: () => apply(Backend.duplicatePages(targets)) },
    { label: "Insert blank page after", icon: FilePlus2, run: () => apply(Backend.insertBlankPage(page + 1, doc.pages[page].width, doc.pages[page].height)) },
    { label: "Crop page", icon: Crop, run: () => { jumpToPage(page); editorState.setTool("crop"); } },
    { label: "Delete", icon: Trash2, disabled: targets.length >= doc.page_count, destructive: true, run: () => apply(Backend.deletePages(targets)) },
  ]);
}
