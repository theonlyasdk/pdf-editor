import { showToolMenu } from "./EditorContextMenu";
import { buildAnnotation, drawingBox, drawingStyle, requestAnnotationText, type AreaRedactItem, type DrawPoint } from "./drawing";
import { computeFitZoom, formatUnitValue, resizeCrop } from "./cropGeometry";
import { clearPendingPlacement, getPendingPlacement } from "./SignatureModal";
import { PageRasterQueue } from "./ui/PageRasterQueue";
import { Backend } from "../ipc/backend";
import { editorState } from "../state/editorState";
import { AnnotationDto, DocumentDto, PageBox, PageInfo, SearchResult, ToolType } from "../types/editor";
import { toast } from "./Toast";

type ExtendedBackend = typeof Backend & {
  addImageAnnotation(pageIndex: number, rect: PageBox, imageBase64: string, opacity: number): Promise<DocumentDto>;
};

type ExtendedEditorState = typeof editorState & {
  zoomFitMode?: "custom" | "fit-width" | "fit-page";
  setZoom(zoom: number, keepFitMode?: boolean): void;
  pendingRedactions?: AreaRedactItem[];
  addPendingRedaction?(item: AreaRedactItem): void;
};

const backend = Backend as ExtendedBackend;
const extState = editorState as ExtendedEditorState;

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
  private fitZoomFrame = 0;
  private applyingFitZoom = false;
  private resizeObserver: ResizeObserver | null = null;

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

    window.addEventListener("zoom-fit-width", () => this.applyFitZoom("fit-width"));
    window.addEventListener("zoom-fit-page", () => this.applyFitZoom("fit-page"));
    window.addEventListener("pending-placement-changed", () => {
      if (!getPendingPlacement()) {
        this.pagesContainer.querySelectorAll(".pending-placement-ghost").forEach((el) => el.remove());
      }
      this.syncInteractionCursors();
    });

    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => {
        const mode = extState.zoomFitMode;
        if (editorState.doc && editorState.viewMode !== "grid" && (mode === "fit-width" || mode === "fit-page")) {
          this.scheduleFitZoom(mode);
        }
      });
      this.resizeObserver.observe(this.element);
    }
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
    if (editorState.activeTool !== "stamp" && getPendingPlacement()) {
      clearPendingPlacement();
    }

    const doc = editorState.doc;
    const mode = editorState.viewMode;
    const fitMode = extState.zoomFitMode;
    if (mode !== "grid" && (fitMode === "fit-width" || fitMode === "fit-page") && !this.applyingFitZoom) {
      const targetZoom = this.computeCurrentFitZoom(fitMode);
      if (targetZoom !== null && Math.abs(targetZoom - editorState.zoom) > 0.002) {
        this.applyingFitZoom = true;
        try {
          extState.setZoom(targetZoom, true);
        } finally {
          this.applyingFitZoom = false;
        }
        return;
      }
    }
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

    this.renderPendingRedactions();
    this.syncInteractionCursors();

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

    const unit = editorState.toolSettings.units;
    hud.innerHTML = `
      <div class="crop-hud-inner">
        <span class="crop-hud-dims">${formatUnitValue(box.width, unit)} × ${formatUnitValue(box.height, unit)} ${unit}</span>
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

      if (e.key === "Escape" && getPendingPlacement()) {
        e.preventDefault();
        clearPendingPlacement();
        toast.show({ message: "Signature/stamp placement cancelled.", type: "info" });
        return;
      }

      if ((e.key === "Delete" || e.key === "Backspace") &&
          editorState.activeTool === "select" &&
          editorState.selectedAnnotationId &&
          !editorState.openingFile &&
          !(e.target instanceof Element && e.target.closest("input, select, textarea, button, [contenteditable], dialog")) &&
          !document.querySelector("#palette-modal")?.getBoundingClientRect().width) {
        const annot = editorState.doc?.annotations?.find((a) => a.id === editorState.selectedAnnotationId);
        if (annot) {
          e.preventDefault();
          if (annot.locked) {
            toast.show({ message: "Unlock this annotation before deleting.", type: "warning" });
          } else {
            void Backend.deleteAnnotation(annot.page_index, annot.id)
              .then((updated) => editorState.updateDocument(updated))
              .catch((err) => toast.show({ message: String(err), type: "error" }));
          }
          return;
        }
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
    svg.addEventListener("pointerdown", async (event) => {
      const tool = editorState.activeTool;
      if (!event.button && tool === "select" && editorState.viewMode !== "grid") {
        editorState.setCurrentPage(pageIndex);
        editorState.selectAnnotation(this.annotationAt(event, pageIndex)?.id ?? null);
        return;
      }
      const placement = tool === "stamp" ? getPendingPlacement() : null;
      if (!event.button && placement && editorState.viewMode !== "grid") {
        event.preventDefault();
        event.stopPropagation();
        const page = editorState.doc?.pages[pageIndex];
        if (!page) return;
        const pt = pointAt(event);
        const w = Math.min(page.width, placement.width);
        const h = Math.min(page.height, placement.height);
        const rect: PageBox = {
          x: Math.max(0, Math.min(page.width - w, pt.x - w / 2)),
          y: Math.max(0, Math.min(page.height - h, pt.y - h / 2)),
          width: w,
          height: h,
        };
        const documentVersion = editorState.documentVersion;
        svg.querySelector(".pending-placement-ghost")?.remove();
        clearPendingPlacement();
        this.committingDraw = true;
        try {
          const updated = await backend.addImageAnnotation(pageIndex, rect, placement.imageBase64, placement.opacity);
          if (editorState.documentVersion === documentVersion) {
            editorState.updateDocument(updated);
            editorState.setTool("select");
            editorState.setCurrentPage(pageIndex);
          }
          toast.show({ message: `Placed ${placement.label} on page ${pageIndex + 1}.`, type: "success" });
        } catch (error) {
          toast.show({ message: `Could not place image: ${String(error)}`, type: "error" });
        } finally {
          this.committingDraw = false;
        }
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
      const placement = editorState.activeTool === "stamp" ? getPendingPlacement() : null;
      if (placement && !this.draw && editorState.viewMode !== "grid") {
        this.renderPlacementGhost(svg, pageIndex, pointAt(event), placement.width, placement.height, placement.imageBase64, placement.opacity);
        return;
      }
      const draw = this.draw;
      if (!draw || draw.pointer !== event.pointerId || draw.svg !== svg) return;
      const point = pointAt(event);
      const points = draw.points;
      if ((draw.tool === "pen" || draw.tool === "highlighter") && !event.shiftKey) points.push(point);
      else points.splice(1, points.length, point);
      this.renderDrawPreview(svg, draw.tool, points);
    });
    svg.addEventListener("pointerleave", () => {
      svg.querySelector(".pending-placement-ghost")?.remove();
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
        if (tool === "trueRedact") {
          preview?.remove();
          if (rect.width >= 3 && rect.height >= 3) {
            extState.addPendingRedaction?.({ page_index: pageIndex, rect });
          }
          return;
        }
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
    const stroke = tool === "trueRedact" ? "#dc2626" : style.stroke;
    const fill = ink || line ? "none"
      : tool === "trueRedact" ? "rgba(220, 38, 38, 0.18)"
      : tool === "coverErase" ? settings.coverColor
      : tool === "highlight" ? style.stroke : settings.fillColor || "none";
    const attrs: Record<string, string | number> = {
      stroke,
      fill,
      "stroke-width": tool === "trueRedact" ? 2 : style.width,
      opacity: tool === "trueRedact" ? 1 : style.opacity,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    };
    if (tool === "trueRedact") {
      attrs["stroke-dasharray"] = "6 3";
      attrs["vector-effect"] = "non-scaling-stroke";
    }
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

  private renderPendingRedactions() {
    const queue = extState.pendingRedactions ?? [];
    for (const frame of this.pagesContainer.children) {
      const pageEl = frame as HTMLElement;
      const pageIndex = Number(pageEl.dataset.pageIndex);
      const svg = pageEl.querySelector("svg");
      if (!svg) continue;
      svg.querySelector(".pending-redactions-layer")?.remove();
      const items = queue.map((item, index) => ({ item, index })).filter(({ item }) => item.page_index === pageIndex);
      if (!items.length) continue;

      const group = document.createElementNS(svg.namespaceURI, "g");
      group.setAttribute("class", "pending-redactions-layer");
      group.setAttribute("pointer-events", "none");
      for (const { item, index } of items) {
        const rect = document.createElementNS(svg.namespaceURI, "rect");
        rect.setAttribute("x", String(item.rect.x));
        rect.setAttribute("y", String(item.rect.y));
        rect.setAttribute("width", String(item.rect.width));
        rect.setAttribute("height", String(item.rect.height));
        rect.setAttribute("fill", "rgba(220, 38, 38, 0.18)");
        rect.setAttribute("stroke", "#dc2626");
        rect.setAttribute("stroke-width", "2");
        rect.setAttribute("stroke-dasharray", "6 3");
        rect.setAttribute("vector-effect", "non-scaling-stroke");
        group.appendChild(rect);

        const label = document.createElementNS(svg.namespaceURI, "text");
        label.setAttribute("x", String(item.rect.x + 4));
        label.setAttribute("y", String(item.rect.y + 12));
        label.setAttribute("fill", "#dc2626");
        label.setAttribute("font-size", "10");
        label.setAttribute("font-weight", "700");
        label.textContent = `#${index + 1}`;
        group.appendChild(label);
      }
      svg.appendChild(group);
    }
  }

  private syncInteractionCursors() {
    const tool = editorState.activeTool;
    const isCrosshair = tool === "trueRedact" || (tool === "stamp" && Boolean(getPendingPlacement()));
    for (const svg of this.pagesContainer.querySelectorAll<SVGSVGElement>(".pdf-annotation-layer")) {
      svg.style.cursor = isCrosshair ? "crosshair" : "";
      svg.style.touchAction = isCrosshair ? "none" : "";
    }
  }

  private renderPlacementGhost(
    svg: SVGSVGElement,
    pageIndex: number,
    pt: DrawPoint,
    width: number,
    height: number,
    imageBase64: string,
    opacity: number,
  ) {
    const page = editorState.doc?.pages[pageIndex];
    if (!page) return;
    const w = Math.min(page.width, width);
    const h = Math.min(page.height, height);
    const x = Math.max(0, Math.min(page.width - w, pt.x - w / 2));
    const y = Math.max(0, Math.min(page.height - h, pt.y - h / 2));

    let ghost = svg.querySelector(".pending-placement-ghost");
    if (!ghost) {
      const ns = "http://www.w3.org/2000/svg";
      ghost = document.createElementNS(ns, "g");
      ghost.setAttribute("class", "pending-placement-ghost");
      ghost.setAttribute("pointer-events", "none");
      const img = document.createElementNS(ns, "image");
      const outline = document.createElementNS(ns, "rect");
      outline.setAttribute("fill", "none");
      outline.setAttribute("stroke", "var(--ring)");
      outline.setAttribute("stroke-width", "1.5");
      outline.setAttribute("stroke-dasharray", "4 3");
      outline.setAttribute("vector-effect", "non-scaling-stroke");
      ghost.append(img, outline);
      svg.appendChild(ghost);
    }
    const img = ghost.querySelector("image")!;
    const outline = ghost.querySelector("rect")!;
    if (img.getAttribute("href") !== imageBase64) img.setAttribute("href", imageBase64);
    img.setAttribute("x", String(x));
    img.setAttribute("y", String(y));
    img.setAttribute("width", String(w));
    img.setAttribute("height", String(h));
    img.setAttribute("opacity", String(Math.max(0.25, opacity * 0.85)));
    outline.setAttribute("x", String(x));
    outline.setAttribute("y", String(y));
    outline.setAttribute("width", String(w));
    outline.setAttribute("height", String(h));
  }

  private computeCurrentFitZoom(fitMode: "fit-width" | "fit-page"): number | null {
    const doc = editorState.doc;
    if (!doc || this.element.clientWidth <= 0 || this.element.clientHeight <= 0) return null;
    const cs = getComputedStyle(this.element);
    const padX = (parseFloat(cs.paddingLeft) || 24) + (parseFloat(cs.paddingRight) || 24);
    const padY = (parseFloat(cs.paddingTop) || 24) + (parseFloat(cs.paddingBottom) || 24);

    let contentW = doc.pages[editorState.currentPage]?.width ?? 612;
    let contentH = doc.pages[editorState.currentPage]?.height ?? 792;
    let extraGapX = 0;

    if (editorState.viewMode === "spread") {
      const p = editorState.currentPage;
      const spreadPages = (p % 2 === 0 ? [p, p + 1] : [p - 1, p]).filter((idx) => idx >= 0 && idx < doc.page_count);
      if (spreadPages.length === 2) {
        contentW = doc.pages[spreadPages[0]].width + doc.pages[spreadPages[1]].width;
        contentH = Math.max(doc.pages[spreadPages[0]].height, doc.pages[spreadPages[1]].height);
        extraGapX = 24;
      }
    }

    return computeFitZoom(this.element.clientWidth, this.element.clientHeight, contentW, contentH, fitMode, padX + extraGapX, padY);
  }

  private applyFitZoom(fitMode: "fit-width" | "fit-page") {
    if (!editorState.doc || editorState.viewMode === "grid") return;
    const nextZoom = this.computeCurrentFitZoom(fitMode);
    if (nextZoom === null) return;
    if (Math.abs(nextZoom - editorState.zoom) > 0.002) {
      this.applyingFitZoom = true;
      try {
        extState.setZoom(nextZoom, true);
      } finally {
        this.applyingFitZoom = false;
      }
    }
  }

  private scheduleFitZoom(fitMode: "fit-width" | "fit-page") {
    if (this.fitZoomFrame) cancelAnimationFrame(this.fitZoomFrame);
    this.fitZoomFrame = requestAnimationFrame(() => {
      this.fitZoomFrame = 0;
      this.applyFitZoom(fitMode);
    });
  }
}
