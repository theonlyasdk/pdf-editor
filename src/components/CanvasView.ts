import { showToolMenu } from "./EditorContextMenu";
import { buildAnnotation, drawingBox, drawingStyle, requestAnnotationText, type DrawPoint } from "./drawing";
import { resizeCrop } from "./cropGeometry";
import { PageRasterQueue } from "./ui/PageRasterQueue";
import { Backend } from "../ipc/backend";
import { editorState } from "../state/editorState";
import { AnnotationDto, PageBox, PageInfo, SearchResult, ToolType } from "../types/editor";
import { toast } from "./Toast";

export class CanvasViewportView {
  private element: HTMLElement;
  private pagesContainer: HTMLElement;
  private raster: PageRasterQueue;
  private selectedAnnotation: AnnotationDto | null = null;
  private layout = "";
  private rasterVersion = -1;
  private appliedZoom = 0;
  private scrollFrame = 0;
  private canvasZoomAnchor: { x: number; y: number } | null = null;
  private cropOverlayPage: number | null = null;
  private shownCropBox: PageBox | null = null;
  private shownCropRatio = "";
  private draw: { pointer: number; svg: SVGSVGElement; tool: ToolType; points: DrawPoint[] } | null = null;
  private committingDraw = false;

  // Interactive Crop State
  private isCtrlHeld = false;
  private cropDrag: {
    pointer: number;
    handle: string;
    page: number;
    svg: SVGSVGElement;
    start: DOMPoint;
    box: PageBox;
    preview: PageBox;
  } | null = null;
  private gridZoom: number | null = null;
  private gridOrigin = { x: 0, y: 0 };
  private gridZoomAnchor: { x: number; y: number } | null = null;
  private gridDrag: { pointer: number; x: number; y: number; moved: boolean; page?: number } | null = null;

  constructor(element: HTMLElement) {
    this.element = element;
    this.raster = new PageRasterQueue(element);
    this.element.className = "canvas-viewport";
    this.element.tabIndex = 0;

    this.pagesContainer = document.createElement("div");
    this.pagesContainer.className = "canvas-pages-container";
    this.element.appendChild(this.pagesContainer);

    this.render();
    editorState.subscribe(() => this.render());
    this.bindViewportEvents();
    this.bindGlobalCropEvents();
    this.element.addEventListener("contextmenu", (event) => {
      if (!editorState.doc) return;
      const page = (event.target as Element).closest<HTMLElement>(".pdf-page-wrapper")?.dataset.pageIndex;
      const index = page === undefined ? undefined : Number(page);
      showToolMenu(event, index, index === undefined ? undefined : this.annotationAt(event, index));
    });
    window.addEventListener("document-search-result", (event) => {
      const hit = (event as CustomEvent<SearchResult | null>).detail;
      this.pagesContainer.querySelector(".search-highlight")?.remove();
      if (!hit) return;
      const svg = this.pagesContainer.querySelector(`#pdf-page-${hit.page_index} svg`);
      if (!svg) return;
      const group = document.createElementNS(svg.namespaceURI, "g");
      group.setAttribute("class", "search-highlight");
      for (const box of hit.bounding_boxes) {
        const mark = document.createElementNS(svg.namespaceURI, "rect");
        for (const [key, value] of Object.entries(box)) mark.setAttribute(key, String(value));
        group.appendChild(mark);
      }
      svg.prepend(group);
      if (editorState.viewMode !== "grid" && group.childElementCount) {
        group.scrollIntoView({ behavior: "instant", block: "center", inline: "nearest" });
      }
    });
  }

  private render() {
    if (!editorState.doc) {
      this.raster.reset();
      this.pagesContainer.replaceChildren();
      this.element.style.display = "none";
      return;
    }
    this.element.style.display = "flex";
    this.element.dataset.tool = editorState.activeTool;

    const doc = editorState.doc;
    const mode = editorState.viewMode;
    const zoom = editorState.zoom;

    this.pagesContainer.className = `canvas-pages-container ${mode}`;
    this.element.classList.toggle("grid-viewport", mode === "grid");
    if (mode !== "grid") {
      this.gridZoom = null;
      this.pagesContainer.style.transform = "";
    }
    const pageZoom = mode === "grid" ? 0.32 : zoom;

    // Decide which pages to display based on view mode
    let pagesToRender: number[] = [];
    if (mode === "single") {
      pagesToRender = [editorState.currentPage];
    } else if (mode === "spread") {
      const p = editorState.currentPage;
      if (p % 2 === 0) {
        pagesToRender = [p, p + 1].filter((idx) => idx < doc.page_count);
      } else {
        pagesToRender = [p - 1, p].filter((idx) => idx >= 0);
      }
    } else {
      // continuous or grid: all pages
      pagesToRender = Array.from({ length: doc.page_count }, (_, i) => i);
    }

    const layout = `${editorState.documentVersion}:${mode}:${pagesToRender[0]}:${pagesToRender.length}`;
    const rebuild = this.layout !== layout;
    const zoomChanged = this.appliedZoom !== pageZoom;
    if (rebuild) {
      if (mode === "grid" && this.layout.split(":")[0] !== String(editorState.documentVersion)) this.gridZoom = null;
      this.layout = layout;
      this.cropOverlayPage = null;
      this.raster.reset();
      const pages = document.createDocumentFragment();
      for (const index of pagesToRender) {
        pages.appendChild(this.createPageElement(index, doc.pages[index], pageZoom));
      }
      this.pagesContainer.replaceChildren(pages);
    } else if (zoomChanged || this.rasterVersion !== editorState.rasterVersion) {
      const focused = this.pagesContainer.querySelector<HTMLElement>(`#pdf-page-${editorState.currentPage}`);
      const anchor = this.canvasZoomAnchor ?? { x: this.element.clientWidth / 2, y: this.element.clientHeight / 2 };
      const viewport = this.element.getBoundingClientRect();
      const before = focused?.getBoundingClientRect();
      for (const frame of this.pagesContainer.children) {
        const pageFrame = frame as HTMLElement;
        this.updatePageFrame(pageFrame, doc.pages[Number(pageFrame.dataset.pageIndex)], pageZoom);
      }
      if (zoomChanged && before && focused && mode !== "grid") {
        const after = focused.getBoundingClientRect();
        const x = viewport.left + anchor.x;
        const y = viewport.top + anchor.y;
        this.element.scrollLeft += after.left + (x - before.left) * after.width / before.width - x;
        this.element.scrollTop += after.top + (y - before.top) * after.height / before.height - y;
      }
      this.cropOverlayPage = null;
    }
    this.canvasZoomAnchor = null;
    this.appliedZoom = pageZoom;
    this.rasterVersion = editorState.rasterVersion;
    if (mode === "grid") this.updateGridZoom(zoom);

    const selected = editorState.activeTool === "select"
      ? doc.annotations?.find(({ id }) => id === editorState.selectedAnnotationId) ?? null
      : null;
    if (rebuild || this.selectedAnnotation !== selected) {
      this.pagesContainer.querySelector(".annotation-selection")?.remove();
      if (selected) {
        const svg = this.pagesContainer.querySelector(`#pdf-page-${selected.page_index} svg`);
        if (svg) {
          const outline = document.createElementNS(svg.namespaceURI, "rect");
          outline.setAttribute("class", "annotation-selection");
          for (const [key, value] of Object.entries(selected.rect)) outline.setAttribute(key, String(value));
          svg.appendChild(outline);
        }
      }
      this.selectedAnnotation = selected;
    }

    const cropPage = editorState.activeTool === "crop" ? editorState.currentPage : null;
    const cropBox = editorState.cropBox;
    const ratio = editorState.toolSettings.cropRatioMode;
    if (cropPage === this.cropOverlayPage && cropBox === this.shownCropBox && ratio === this.shownCropRatio) return;
    this.pagesContainer.querySelector(".crop-interactive-overlay")?.remove();
    this.pagesContainer.querySelector(".crop-floating-hud")?.remove();
    this.cropOverlayPage = cropPage;
    this.shownCropBox = cropBox;
    this.shownCropRatio = ratio;
    if (cropPage === null || !cropBox) return;

    const wrapper = this.pagesContainer.querySelector<HTMLElement>(`#pdf-page-${cropPage}`);
    const svg = wrapper?.querySelector("svg");
    if (wrapper && svg) {
      this.renderCropOverlay(wrapper, svg, doc.pages[cropPage], pageZoom, cropBox);
    }
  }

  private createPageElement(pageIndex: number, pageInfo: PageInfo, zoom: number): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "pdf-page-wrapper";
    wrapper.id = `pdf-page-${pageIndex}`;
    wrapper.dataset.pageIndex = String(pageIndex);

    // Page Image Canvas
    const img = document.createElement("img");
    img.className = "pdf-page-canvas";
    img.style.width = "100%";
    img.style.height = "100%";
    img.draggable = false;
    img.alt = `Page ${pageIndex + 1}`;
    wrapper.appendChild(img);

    // SVG Drawing & Interactive Annotation Layer
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "pdf-annotation-layer");
    svg.setAttribute("viewBox", `0 0 ${pageInfo.width} ${pageInfo.height}`);
    svg.setAttribute("data-page-index", pageIndex.toString());
    wrapper.appendChild(svg);

    this.bindDrawingOnSvg(svg, pageIndex);
    this.updatePageFrame(wrapper, pageInfo, zoom);
    wrapper.addEventListener("page-raster-ready", () => {
      svg.querySelectorAll(".pending-draw-preview").forEach((preview) => preview.remove());
    });

    return wrapper;
  }

  private updatePageFrame(frame: HTMLElement, page: PageInfo, zoom: number) {
    const width = Math.max(1, Math.round(page.width * zoom));
    frame.style.width = `${width}px`;
    frame.style.height = `${Math.max(1, Math.round(page.height * zoom))}px`;
    frame.querySelector("svg")!.setAttribute("viewBox", `0 0 ${page.width} ${page.height}`);
    const pixels = Math.min(4000, Math.max(800, Math.ceil(width * (window.devicePixelRatio || 1) / 200) * 200));
    const request = `${editorState.rasterVersion}:${pixels}`;
    if (frame.dataset.request !== request) {
      frame.dataset.request = request;
      this.raster.add(frame, frame.querySelector("img")!, page.index, pixels);
    }
  }

  /**
   * Renders the interactive crop overlay with dimmed exterior, rule-of-thirds grid,
   * 8 resize handles, and floating HUD pill with fixed/free ratio indicator.
   */
  private renderCropOverlay(
    wrapper: HTMLElement,
    svg: SVGSVGElement,
    pageInfo: PageInfo,
    zoom: number,
    box: PageBox
  ) {
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("class", "crop-interactive-overlay");

    // 1. Dimmed exterior shroud (4 rects around the crop window)
    const shroudTop = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    shroudTop.setAttribute("x", "0");
    shroudTop.setAttribute("y", "0");
    shroudTop.setAttribute("width", pageInfo.width.toString());
    shroudTop.setAttribute("height", Math.max(0, box.y).toString());
    shroudTop.setAttribute("class", "crop-shroud");
    g.appendChild(shroudTop);

    const shroudBottom = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    shroudBottom.setAttribute("x", "0");
    shroudBottom.setAttribute("y", (box.y + box.height).toString());
    shroudBottom.setAttribute("width", pageInfo.width.toString());
    shroudBottom.setAttribute("height", Math.max(0, pageInfo.height - (box.y + box.height)).toString());
    shroudBottom.setAttribute("class", "crop-shroud");
    g.appendChild(shroudBottom);

    const shroudLeft = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    shroudLeft.setAttribute("x", "0");
    shroudLeft.setAttribute("y", box.y.toString());
    shroudLeft.setAttribute("width", Math.max(0, box.x).toString());
    shroudLeft.setAttribute("height", box.height.toString());
    shroudLeft.setAttribute("class", "crop-shroud");
    g.appendChild(shroudLeft);

    const shroudRight = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    shroudRight.setAttribute("x", (box.x + box.width).toString());
    shroudRight.setAttribute("y", box.y.toString());
    shroudRight.setAttribute("width", Math.max(0, pageInfo.width - (box.x + box.width)).toString());
    shroudRight.setAttribute("height", box.height.toString());
    shroudRight.setAttribute("class", "crop-shroud");
    g.appendChild(shroudRight);

    // 2. Crop box outline (crisp dashed boundary with drop shadow)
    const outline = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    outline.setAttribute("x", box.x.toString());
    outline.setAttribute("y", box.y.toString());
    outline.setAttribute("width", box.width.toString());
    outline.setAttribute("height", box.height.toString());
    outline.setAttribute("class", "crop-box-outline");
    g.appendChild(outline);

    // 3. Rule of Thirds gridlines inside the crop box
    const h1 = document.createElementNS("http://www.w3.org/2000/svg", "line");
    h1.setAttribute("x1", box.x.toString());
    h1.setAttribute("y1", (box.y + box.height / 3).toString());
    h1.setAttribute("x2", (box.x + box.width).toString());
    h1.setAttribute("y2", (box.y + box.height / 3).toString());
    h1.setAttribute("class", "crop-grid-line");
    g.appendChild(h1);

    const h2 = document.createElementNS("http://www.w3.org/2000/svg", "line");
    h2.setAttribute("x1", box.x.toString());
    h2.setAttribute("y1", (box.y + (2 * box.height) / 3).toString());
    h2.setAttribute("x2", (box.x + box.width).toString());
    h2.setAttribute("y2", (box.y + (2 * box.height) / 3).toString());
    h2.setAttribute("class", "crop-grid-line");
    g.appendChild(h2);

    const v1 = document.createElementNS("http://www.w3.org/2000/svg", "line");
    v1.setAttribute("x1", (box.x + box.width / 3).toString());
    v1.setAttribute("y1", box.y.toString());
    v1.setAttribute("x2", (box.x + box.width / 3).toString());
    v1.setAttribute("y2", (box.y + box.height).toString());
    v1.setAttribute("class", "crop-grid-line");
    g.appendChild(v1);

    const v2 = document.createElementNS("http://www.w3.org/2000/svg", "line");
    v2.setAttribute("x1", (box.x + (2 * box.width) / 3).toString());
    v2.setAttribute("y1", box.y.toString());
    v2.setAttribute("x2", (box.x + (2 * box.width) / 3).toString());
    v2.setAttribute("y2", (box.y + box.height).toString());
    v2.setAttribute("class", "crop-grid-line");
    g.appendChild(v2);

    // 4. Center Move Target
    const moveTarget = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    moveTarget.setAttribute("x", box.x.toString());
    moveTarget.setAttribute("y", box.y.toString());
    moveTarget.setAttribute("width", box.width.toString());
    moveTarget.setAttribute("height", box.height.toString());
    moveTarget.setAttribute("fill", "transparent");
    moveTarget.setAttribute("style", "cursor: move;");
    moveTarget.setAttribute("data-handle", "move");
    g.appendChild(moveTarget);

    // 5. Four Corner Handles (nw, ne, se, sw)
    const cornerSize = 14;
    const addCornerHandle = (handleId: string, hx: number, hy: number, cursor: string) => {
      // Visible corner bracket handle
      const h = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      h.setAttribute("x", (hx - cornerSize / 2).toString());
      h.setAttribute("y", (hy - cornerSize / 2).toString());
      h.setAttribute("width", cornerSize.toString());
      h.setAttribute("height", cornerSize.toString());
      h.setAttribute("class", "crop-handle-corner");
      h.setAttribute("style", `cursor: ${cursor};`);
      h.setAttribute("data-handle", handleId);
      g.appendChild(h);
    };

    addCornerHandle("nw", box.x, box.y, "nwse-resize");
    addCornerHandle("ne", box.x + box.width, box.y, "nesw-resize");
    addCornerHandle("se", box.x + box.width, box.y + box.height, "nwse-resize");
    addCornerHandle("sw", box.x, box.y + box.height, "nesw-resize");

    // 6. Four Edge Handles (n, s, w, e)
    const edgeLength = 26;
    const edgeThick = 7;
    const addEdgeHandle = (
      handleId: string,
      hx: number,
      hy: number,
      w: number,
      h: number,
      cursor: string
    ) => {
      const el = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      el.setAttribute("x", (hx - w / 2).toString());
      el.setAttribute("y", (hy - h / 2).toString());
      el.setAttribute("width", w.toString());
      el.setAttribute("height", h.toString());
      el.setAttribute("class", "crop-handle-edge");
      el.setAttribute("style", `cursor: ${cursor};`);
      el.setAttribute("data-handle", handleId);
      g.appendChild(el);
    };

    addEdgeHandle("n", box.x + box.width / 2, box.y, edgeLength, edgeThick, "ns-resize");
    addEdgeHandle("s", box.x + box.width / 2, box.y + box.height, edgeLength, edgeThick, "ns-resize");
    addEdgeHandle("w", box.x, box.y + box.height / 2, edgeThick, edgeLength, "ew-resize");
    addEdgeHandle("e", box.x + box.width, box.y + box.height / 2, edgeThick, edgeLength, "ew-resize");

    svg.appendChild(g);

    g.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || this.cropDrag) return;
      const handle = (event.target as Element).closest("[data-handle]")?.getAttribute("data-handle");
      const matrix = svg.getScreenCTM();
      if (!handle || !matrix) return;
      event.stopPropagation();
      event.preventDefault();
      svg.setPointerCapture(event.pointerId);
      this.cropDrag = {
        pointer: event.pointerId, handle, page: pageInfo.index, svg,
        start: new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse()),
        box, preview: box,
      };
    });

    // 7. Floating HUD / Action Bar attached to Crop Box
    const isLocked = this.isCtrlHeld || editorState.toolSettings.cropRatioMode !== "free";
    const hud = document.createElement("div");
    hud.className = "crop-floating-hud";

    const scaledHeight = Math.round(pageInfo.height * zoom);
    const hudLeft = Math.round((box.x + box.width / 2) * zoom);
    let hudTop = Math.round((box.y + box.height) * zoom) + 10;
    // If overflowing below page, flip above
    if (hudTop + 45 > scaledHeight) {
      hudTop = Math.max(8, Math.round(box.y * zoom) - 45);
    }

    hud.style.left = `${hudLeft}px`;
    hud.style.top = `${hudTop}px`;
    hud.style.transform = "translateX(-50%)";

    hud.innerHTML = `
      <div class="crop-hud-inner">
        <span class="crop-hud-dims">${Math.round(box.width)} × ${Math.round(box.height)} pt</span>
        <span class="crop-hud-badge ${isLocked ? "locked" : ""}" id="crop-hud-ratio-tag">
          ${isLocked ? `Fixed ratio (${(box.width / Math.max(1, box.height)).toFixed(2)})` : "Free Ratio (Hold Ctrl to Lock)"}
        </span>
        <div class="crop-hud-actions">
          <button class="ui-button ui-button--sm ui-button--default py-0 px-2 font-medium" id="hud-crop-apply">Apply (Enter)</button>
          <button class="ui-button ui-button--sm ui-button--outline py-0 px-2" id="hud-crop-cancel">Cancel (Esc)</button>
        </div>
      </div>
    `;

    hud.querySelector("#hud-crop-apply")?.addEventListener("click", () => this.applyActiveCrop());
    hud.querySelector("#hud-crop-cancel")?.addEventListener("click", () => this.cancelActiveCrop());

    wrapper.appendChild(hud);
  }

  private bindGlobalCropEvents() {
    // Window key listeners for Ctrl ratio toggle and Enter/Esc shortcuts
    window.addEventListener("keydown", (e) => {
      if (e.key === "Control") {
        this.isCtrlHeld = true;
        this.updateCropHudBadges();
      }

      if (editorState.activeTool === "crop" && !editorState.openingFile &&
          !(e.target instanceof Element && e.target.closest("input, select, textarea, button, [contenteditable]")) &&
          !document.querySelector("#palette-modal")?.getBoundingClientRect().width) {
        if (e.key === "Enter") {
          e.preventDefault();
          this.applyActiveCrop();
        } else if (e.key === "Escape") {
          e.preventDefault();
          this.cancelActiveCrop();
        }
      }
    });

    window.addEventListener("keyup", (e) => {
      if (e.key === "Control") {
        this.isCtrlHeld = false;
        this.updateCropHudBadges();
      }
    });

    window.addEventListener("blur", () => {
      this.isCtrlHeld = false;
      this.updateCropHudBadges();
    });

    this.element.addEventListener("pointermove", (event) => {
      const drag = this.cropDrag;
      if (!drag || drag.pointer !== event.pointerId || editorState.activeTool !== "crop") return;
      const page = editorState.doc?.pages[drag.page];
      const matrix = drag.svg.getScreenCTM();
      const wrapper = drag.svg.parentElement;
      if (!page || !matrix || !wrapper) return;
      const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
      const mode = editorState.toolSettings.cropRatioMode;
      const ratios = { original: page.width / page.height, "1:1": 1, "4:3": 4 / 3, "16:9": 16 / 9 };
      const ratio = mode === "free" ? (event.ctrlKey ? drag.box.width / drag.box.height : undefined) : ratios[mode];
      drag.preview = resizeCrop(drag.box, drag.handle, point.x - drag.start.x, point.y - drag.start.y, page, ratio);
      drag.svg.querySelector(".crop-interactive-overlay")?.remove();
      wrapper.querySelector(".crop-floating-hud")?.remove();
      this.renderCropOverlay(wrapper, drag.svg, page, wrapper.clientWidth / page.width, drag.preview);
    });

    const finish = (event: PointerEvent) => {
      const drag = this.cropDrag;
      if (!drag || drag.pointer !== event.pointerId) return;
      this.cropDrag = null;
      if (drag.svg.isConnected && editorState.activeTool === "crop" && editorState.currentPage === drag.page) {
        editorState.setCropBox(event.type === "pointerup" ? drag.preview : { ...drag.box });
      }
    };
    this.element.addEventListener("pointerup", finish);
    this.element.addEventListener("pointercancel", finish);
    this.element.addEventListener("lostpointercapture", finish);
  }

  private updateCropHudBadges() {
    const isLocked = this.isCtrlHeld || editorState.toolSettings.cropRatioMode !== "free";
    const tag = document.querySelector("#crop-hud-ratio-tag");
    if (tag) {
      if (isLocked) {
        tag.classList.add("locked");
        const ratio = editorState.cropBox
          ? (editorState.cropBox.width / Math.max(1, editorState.cropBox.height)).toFixed(2)
          : "1.00";
        tag.textContent = `Fixed ratio (${ratio})`;
      } else {
        tag.classList.remove("locked");
        tag.textContent = "Free Ratio (Hold Ctrl to Lock)";
      }
    }
  }

  async applyActiveCrop() {
    if (!editorState.cropBox || !editorState.doc) return;
    try {
      const page = editorState.currentPage;
      const updated = await Backend.cropPages([page], editorState.cropBox, editorState.toolSettings.cropRatioMode !== "free");
      editorState.updateDocument(updated);
      editorState.setTool("select");
      editorState.setCurrentPage(page);
      toast.show({
        message: `Crop applied to page ${page + 1}`,
        type: "success",
      });
    } catch (err: any) {
      toast.show({ message: err.toString(), type: "error" });
    }
  }

  cancelActiveCrop() {
    editorState.setCropBox(null);
    editorState.setTool("select");
  }

  private annotationAt(event: MouseEvent, page: number) {
    const svg = this.pagesContainer.querySelector<SVGSVGElement>(`#pdf-page-${page} svg`);
    const matrix = svg?.getScreenCTM();
    if (!matrix) return;
    const { x, y } = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return editorState.doc?.annotations?.findLast(({ rect, page_index }) =>
      page_index === page && x >= rect.x && y >= rect.y && x <= rect.x + rect.width && y <= rect.y + rect.height);
  }

  private bindDrawingOnSvg(svg: SVGSVGElement, pageIndex: number) {
    const pointAt = (event: PointerEvent) => {
      const page = editorState.doc!.pages[pageIndex];
      const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(svg.getScreenCTM()!.inverse());
      return { x: Math.max(0, Math.min(page.width, point.x)), y: Math.max(0, Math.min(page.height, point.y)) };
    };
    svg.addEventListener("pointerdown", (event) => {
      const tool = editorState.activeTool;
      if (!event.button && tool === "select" && editorState.viewMode !== "grid") {
        editorState.setCurrentPage(pageIndex);
        editorState.selectAnnotation(this.annotationAt(event, pageIndex)?.id ?? null);
        return;
      }
      if (!event.button && tool === "trueRedact") {
        document.getElementById("prop-redact-keyword")?.focus();
        return;
      }
      if (event.button || this.draw || this.committingDraw || ["select", "hand", "crop"].includes(tool)) return;
      event.preventDefault();
      event.stopPropagation();
      editorState.setCurrentPage(pageIndex);
      svg.setPointerCapture(event.pointerId);
      this.draw = { pointer: event.pointerId, svg, tool, points: [pointAt(event)] };
    });
    svg.addEventListener("pointermove", (event) => {
      const draw = this.draw;
      if (!draw || draw.pointer !== event.pointerId || draw.svg !== svg) return;
      const point = pointAt(event);
      const points = draw.points;
      if ((draw.tool === "pen" || draw.tool === "highlighter") && !event.shiftKey) points.push(point);
      else points.splice(1, points.length, point);
      this.renderDrawPreview(svg, draw.tool, points);
    });
    svg.addEventListener("pointerup", async (event) => {
      const draw = this.draw;
      if (!draw || draw.pointer !== event.pointerId || draw.svg !== svg) return;
      this.draw = null;
      this.committingDraw = true;
      const documentVersion = editorState.documentVersion;
      const { tool, points } = draw;
      const end = pointAt(event);
      if (tool === "pen" || tool === "highlighter") {
        if (points.length === 1 && points[0].x === end.x && points[0].y === end.y) end.x += 0.3;
        points.push(end);
      } else {
        points.splice(1, points.length, end);
      }
      const preview = svg.querySelector(".temp-draw-preview");
      preview?.classList.replace("temp-draw-preview", "pending-draw-preview");
      try {
        const rect = drawingBox(points);
        if (tool === "coverErase") {
          if (rect.width < 2 || rect.height < 2) { preview?.remove(); return; }
          const settings = editorState.toolSettings;
          const cover = buildAnnotation("rectangle", pageIndex, points, {
            ...settings, strokeColor: settings.coverColor, fillColor: settings.coverColor, opacity: 1, strokeWidth: 1,
          }, null)!;
          const updated = await Backend.addAnnotation({ ...cover, annot_type: "Cover" });
          if (editorState.documentVersion === documentVersion) editorState.updateDocument(updated);
          return;
        }

        let text: string | null = null;
        if (tool === "freeText" || tool === "stickyNote") {
          text = await requestAnnotationText(tool === "freeText" ? "Add text" : "Add a note");
          if (!text) { preview?.remove(); return; }
        } else if (tool === "stamp") {
          text = editorState.toolSettings.stampText;
        }
        const annotation = buildAnnotation(tool, pageIndex, points, editorState.toolSettings, text);
        if (annotation && editorState.documentVersion === documentVersion) {
          const updated = await Backend.addAnnotation(annotation);
          if (editorState.documentVersion === documentVersion) editorState.updateDocument(updated);
        } else {
          preview?.remove();
        }
      } catch (error) {
        preview?.remove();
        toast.show({ message: `Could not edit page: ${String(error)}`, type: "error" });
      } finally {
        this.committingDraw = false;
      }
    });
    const cancel = (event: PointerEvent) => {
      if (this.draw?.pointer !== event.pointerId || this.draw.svg !== svg) return;
      this.draw = null;
      svg.querySelector(".temp-draw-preview")?.remove();
    };
    svg.addEventListener("pointercancel", cancel);
    svg.addEventListener("lostpointercapture", cancel);
  }

  private renderDrawPreview(svg: SVGSVGElement, tool: ToolType, points: DrawPoint[]) {
    const settings = editorState.toolSettings;
    const style = drawingStyle(tool, settings);
    const first = points[0];
    const last = points[points.length - 1];
    const { x, y, width, height } = drawingBox(points);
    const ink = tool === "pen" || tool === "highlighter";
    const line = tool === "line" || tool === "arrow" || tool === "underline" || tool === "strikeout";
    const tag = ink || tool === "arrow" ? "path" : line ? "line" : tool === "circle" ? "ellipse" : "rect";
    let preview = svg.querySelector(".temp-draw-preview");
    if (!preview) {
      preview = document.createElementNS(svg.namespaceURI, tag);
      preview.setAttribute("class", "temp-draw-preview");
      svg.appendChild(preview);
    }
    const stroke = style.stroke;
    const fill = ink || line ? "none" : tool === "coverErase" ? settings.coverColor
      : tool === "highlight" ? style.stroke : settings.fillColor || "none";
    const attrs: Record<string, string | number> = {
      stroke, fill, "stroke-width": style.width, opacity: style.opacity, "stroke-linecap": "round", "stroke-linejoin": "round",
    };
    if (ink) attrs.d = points.map(({ x, y }, i) => `${i === 0 ? "M" : "L"} ${x} ${y}`).join(" ");
    else if (tool === "arrow") {
      const angle = Math.atan2(last.y - first.y, last.x - first.x);
      const wing = (offset: number) => `${last.x - 12 * Math.cos(angle + offset)} ${last.y - 12 * Math.sin(angle + offset)}`;
      attrs.d = `M ${first.x} ${first.y} L ${last.x} ${last.y} M ${wing(-0.5)} L ${last.x} ${last.y} L ${wing(0.5)}`;
    } else if (line) {
      const baseline = tool === "underline" ? y + height : y + height / 2;
      Object.assign(attrs, tool === "line"
        ? { x1: first.x, y1: first.y, x2: last.x, y2: last.y }
        : { x1: x, y1: baseline, x2: x + width, y2: baseline });
    } else if (tool === "circle") {
      Object.assign(attrs, { cx: x + width / 2, cy: y + height / 2, rx: width / 2, ry: height / 2 });
    } else {
      Object.assign(attrs, { x, y, width, height });
    }
    for (const [key, value] of Object.entries(attrs)) preview.setAttribute(key, String(value));
  }

  private writeGridTransform() {
    this.pagesContainer.style.transform =
      `translate(${this.gridOrigin.x}px, ${this.gridOrigin.y}px) scale(${this.gridZoom})`;
  }

  private updateGridZoom(zoom: number) {
    if (this.gridZoom === null) {
      this.gridOrigin = { x: Math.max(24, (this.element.clientWidth - this.pagesContainer.offsetWidth * zoom) / 2), y: 28 };
    } else if (this.gridZoom === zoom) {
      this.gridZoomAnchor = null;
      return;
    } else {
      const anchor = this.gridZoomAnchor ?? { x: this.element.clientWidth / 2, y: this.element.clientHeight / 2 };
      const factor = zoom / this.gridZoom;
      this.gridOrigin = {
        x: anchor.x - (anchor.x - this.gridOrigin.x) * factor,
        y: anchor.y - (anchor.y - this.gridOrigin.y) * factor,
      };
    }
    this.gridZoom = zoom;
    this.gridZoomAnchor = null;
    this.writeGridTransform();
  }

  private bindViewportEvents() {
    this.element.addEventListener("pointerdown", (event) => {
      const grid = editorState.viewMode === "grid";
      if ((event.button !== 0 && event.button !== 1) || (!grid && editorState.activeTool !== "hand" && event.button !== 1)) return;
      const target = event.target as Element;
      if (target.closest("button, input, [data-handle]")) return;
      const page = target.closest<HTMLElement>(".pdf-page-wrapper")?.dataset.pageIndex;
      if (event.button === 0 && page !== undefined && !["select", "hand", "crop"].includes(editorState.activeTool)) return;
      event.preventDefault();
      this.element.setPointerCapture(event.pointerId);
      this.gridDrag = { pointer: event.pointerId, x: event.clientX, y: event.clientY, moved: false, page: page === undefined ? undefined : Number(page) };
      this.element.classList.add("grid-grabbing");
    });
    this.element.addEventListener("pointermove", (event) => {
      const drag = this.gridDrag;
      if (!drag || event.pointerId !== drag.pointer) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 3) return;
      drag.moved = true;
      if (editorState.viewMode === "grid") {
        this.gridOrigin.x += dx;
        this.gridOrigin.y += dy;
        this.writeGridTransform();
      } else {
        this.element.scrollLeft -= dx;
        this.element.scrollTop -= dy;
      }
      drag.x = event.clientX;
      drag.y = event.clientY;
    });
    const endPan = (event: PointerEvent) => {
      const drag = this.gridDrag;
      if (!drag || drag.pointer !== event.pointerId) return;
      this.gridDrag = null;
      this.element.classList.remove("grid-grabbing");
      if (event.type === "pointerup" && event.button === 0 && !drag.moved && drag.page !== undefined) {
        editorState.setCurrentPage(drag.page);
      }
    };
    this.element.addEventListener("pointerup", endPan);
    this.element.addEventListener("pointercancel", endPan);
    this.element.addEventListener("lostpointercapture", endPan);

    this.element.addEventListener("wheel", (event) => {
      if (editorState.viewMode === "grid") {
        event.preventDefault();
        const bounds = this.element.getBoundingClientRect();
        this.gridZoomAnchor = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
        const units = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.element.clientHeight : 1;
        editorState.setZoom(editorState.zoom * Math.exp(-event.deltaY * units * 0.002));
      } else if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const bounds = this.element.getBoundingClientRect();
        this.canvasZoomAnchor = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
        if (event.deltaY < 0) editorState.zoomIn();
        else editorState.zoomOut();
      }
    }, { passive: false });

    this.element.addEventListener("scroll", () => {
      if (this.scrollFrame || editorState.viewMode !== "continuous" || this.cropDrag || this.draw) return;
      this.scrollFrame = requestAnimationFrame(() => {
        this.scrollFrame = 0;
        const bounds = this.element.getBoundingClientRect();
        const middle = (bounds.top + bounds.bottom) / 2;
        const frames = this.pagesContainer.children;
        // Continuous pages are in vertical order. Find the page nearest the viewport center.
        let first = 0;
        let last = frames.length - 1;
        const maxScroll = this.element.scrollHeight - this.element.clientHeight;
        if (maxScroll > 1 && this.element.scrollTop >= maxScroll - 1) first = last;
        else if (this.element.scrollTop <= 1) last = 0;
        while (first < last) {
          const index = (first + last) >> 1;
          if (frames[index].getBoundingClientRect().bottom < middle) first = index + 1;
          else last = index;
        }
        const page = (frames[first] as HTMLElement | undefined)?.dataset.pageIndex;
        if (page !== undefined) editorState.setCurrentPage(Number(page));
      });
    }, { passive: true });

    window.addEventListener("jump-to-page", (event) => {
      const index = (event as CustomEvent<{ pageIndex: number }>).detail.pageIndex;
      const target = this.element.querySelector<HTMLElement>(`#pdf-page-${index}`);
      if (!target) return;
      if (this.gridZoom !== null) {
        this.gridOrigin = {
          x: this.element.clientWidth / 2 - (target.offsetLeft + target.offsetWidth / 2) * this.gridZoom,
          y: this.element.clientHeight / 2 - (target.offsetTop + target.offsetHeight / 2) * this.gridZoom,
        };
        this.writeGridTransform();
      } else {
        const motion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        target.scrollIntoView({ behavior: motion ? "instant" : "smooth", block: "center" });
      }
    });
  }
}
