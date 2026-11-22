import { STRINGS } from "../i18n/strings";
import { Backend } from "../ipc/backend";
import { editorState } from "../state/editorState";
import { toast } from "./Toast";
import type { AnnotationDto, DocumentDto } from "../types/editor";

interface MenuAction {
  label: string;
  run: () => void | Promise<void>;
  disabled?: boolean;
  destructive?: boolean;
  color?: string;
}

let closeOpenMenu: (() => void) | null = null;

export function showContextMenu(event: MouseEvent, title: string, actions: MenuAction[]) {
  event.preventDefault();
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
    if (restore && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  };
  closeOpenMenu = close;

  for (const action of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "context-menu-item";
    button.setAttribute("role", "menuitem");
    button.disabled = Boolean(action.disabled);
    if (action.destructive) button.classList.add("text-destructive");
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
  }

  document.body.appendChild(menu);
  const source = (event.target as Element).getBoundingClientRect();
  const keyboard = event.clientX === 0 && event.clientY === 0;
  menu.style.left = `${Math.max(8, Math.min(keyboard ? source.left : event.clientX, innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(keyboard ? source.bottom : event.clientY, innerHeight - menu.offsetHeight - 8))}px`;
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
    if (!menu.contains(pointer.target as Node)) close();
  }, { signal: listeners.signal, capture: true });
  window.addEventListener("resize", () => close(), { signal: listeners.signal });
  window.addEventListener("blur", () => close(), { signal: listeners.signal });
}

export function showToolMenu(event: MouseEvent, page?: number, annotation?: AnnotationDto) {
  const tool = editorState.activeTool;
  const actions: MenuAction[] = [];
  if (["pen", "highlighter", "rectangle", "circle", "line", "arrow", "freeText", "coverErase"].includes(tool)) {
    const key = tool === "coverErase" ? "coverColor" : "strokeColor";
    for (const [label, color] of [["Black", "#252524"], ["Red", "#d53b42"], ["Blue", "#2563eb"], ["Yellow", "#ffe04a"], ["White", "#ffffff"]]) {
      actions.push({ label, color, run: () => editorState.updateToolSettings({ [key]: color }) });
    }
  }
  if (["pen", "highlighter", "rectangle", "circle", "line", "arrow"].includes(tool)) {
    for (const width of [2, 6, 12]) {
      actions.push({ label: `${width} pt stroke`, run: () => editorState.updateToolSettings({ strokeWidth: width }) });
    }
  }
  if (tool === "crop") {
    actions.push({ label: "Reset crop to full page", run: () => {
      editorState.initCropBoxForCurrentPage();
      editorState.notify();
    } });
  }
  actions.push(
    { label: "Select tool", disabled: tool === "select", run: () => editorState.setTool("select") },
    { label: "Hand tool", disabled: tool === "hand", run: () => editorState.setTool("hand") },
    { label: "Find in document", run: () => { window.dispatchEvent(new Event("open-document-search")); } },
    { label: "Zoom in", run: () => editorState.zoomIn() },
    { label: "Zoom out", run: () => editorState.zoomOut() },
  );
  if (annotation) actions.unshift({
    label: "Delete annotation", destructive: true, run: async () => {
      const updated = await Backend.deleteAnnotation(annotation.page_index, annotation.id);
      editorState.updateDocument(updated);
    },
  });
  if (page !== undefined) actions.push({ label: `Go to page ${page + 1}`, run: () => jumpToPage(page) });
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
    { label: "Go to page", run: () => jumpToPage(page) },
    { label: "Rotate left", run: () => apply(Backend.rotatePages(targets, -90)) },
    { label: "Rotate right", run: () => apply(Backend.rotatePages(targets, 90)) },
    { label: "Duplicate", run: () => apply(Backend.duplicatePages(targets)) },
    { label: "Insert blank page after", run: () => apply(Backend.insertBlankPage(page + 1, doc.pages[page].width, doc.pages[page].height)) },
    { label: "Crop page", run: () => { jumpToPage(page); editorState.setTool("crop"); } },
    { label: "Delete", disabled: targets.length >= doc.page_count, destructive: true, run: () => apply(Backend.deletePages(targets)) },
  ]);
}
