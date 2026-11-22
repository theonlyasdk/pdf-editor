import { Backend } from "../ipc/backend";
import { editorState } from "../state/editorState";
import { AnnotationDto, PageBox, PageInfo } from "../types/editor";
import { toast } from "./Toast";

export class CanvasViewportView {
  private element: HTMLElement;
  private pagesContainer: HTMLElement;
  private renderedPages: Map<number, HTMLImageElement> = new Map();
  private isDrawing = false;
  private startPoint: { x: number; y: number } | null = null;
  private currentSvgOverlay: SVGSVGElement | null = null;
  private activeDrawPath: { x: number; y: number }[] = [];
  private activePageForDraw = 0;

  // Interactive Crop State
  private isCtrlHeld = false;
  private cropDragHandle: string | null = null;
  private cropStartPt: { x: number; y: number } | null = null;
  private cropStartBox: PageBox | null = null;
  private cropStartRatio = 1.0;
  private cropActivePage = 0;

  constructor(element: HTMLElement) {
    this.element = element;
    this.element.className = "canvas-viewport";

    this.pagesContainer = document.createElement("div");
    this.pagesContainer.className = "canvas-pages-container";
    this.element.appendChild(this.pagesContainer);

    this.render();
    editorState.subscribe(() => this.render());
    this.bindViewportEvents();
    this.bindGlobalCropEvents();
  }

  private render() {
    if (!editorState.doc) {
      this.element.style.display = "none";
      return;
    }
    this.element.style.display = "flex";

    const doc = editorState.doc;
    const mode = editorState.viewMode;
    const zoom = editorState.zoom;

    this.pagesContainer.className = `canvas-pages-container ${mode}`;

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

    this.pagesContainer.innerHTML = "";

    for (const pageIdx of pagesToRender) {
      const pageInfo = doc.pages[pageIdx];
      const pageWrapper = this.createPageElement(pageIdx, pageInfo, zoom);
      this.pagesContainer.appendChild(pageWrapper);
    }
  }

  private createPageElement(pageIndex: number, pageInfo: PageInfo, zoom: number): HTMLElement {
    const scaledWidth = Math.round(pageInfo.width * zoom);
    const scaledHeight = Math.round(pageInfo.height * zoom);

    const wrapper = document.createElement("div");
    wrapper.className = "pdf-page-wrapper";
    wrapper.id = `pdf-page-${pageIndex}`;
    wrapper.style.width = `${scaledWidth}px`;
    wrapper.style.height = `${scaledHeight}px`;
    wrapper.setAttribute("data-page-index", pageIndex.toString());

    // Page Image Canvas
    const img = document.createElement("img");
    img.className = "pdf-page-canvas";
    img.style.width = "100%";
    img.style.height = "100%";
    img.alt = `Page ${pageIndex + 1}`;
    wrapper.appendChild(img);

    // High resolution target width (2x for Retina / HiDPI crispness)
    const renderDpiWidth = Math.max(800, Math.round(scaledWidth * (window.devicePixelRatio || 1)));

    // Background asynchronous page rasterization via Backend
    Backend.renderPage(pageIndex, renderDpiWidth)
      .then((dataUrl) => {
        img.src = dataUrl;
      })
      .catch((err) => {
        console.error(`Page ${pageIndex} render error:`, err);
      });

    // SVG Drawing & Interactive Annotation Layer
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "pdf-annotation-layer");
    svg.setAttribute("viewBox", `0 0 ${pageInfo.width} ${pageInfo.height}`);
    svg.setAttribute("data-page-index", pageIndex.toString());
    wrapper.appendChild(svg);

    // If Crop tool is active on this page, render the interactive crop box & handles
    if (editorState.activeTool === "crop" && pageIndex === editorState.currentPage) {
      this.cropActivePage = pageIndex;
      if (!editorState.cropBox) {
        editorState.initCropBoxForCurrentPage();
      }
      this.renderCropOverlay(wrapper, svg, pageIndex, pageInfo, zoom);
    } else {
      this.bindDrawingOnSvg(svg, pageIndex, pageInfo);
    }

    return wrapper;
  }

  /**
   * Renders the interactive crop overlay with dimmed exterior, rule-of-thirds grid,
   * 8 resize handles, and floating HUD pill with fixed/free ratio indicator.
   */
  private renderCropOverlay(
    wrapper: HTMLElement,
    svg: SVGSVGElement,
    pageIndex: number,
    pageInfo: PageInfo,
    zoom: number
  ) {
    const box = editorState.cropBox || {
      x: Math.round(pageInfo.width * 0.08),
      y: Math.round(pageInfo.height * 0.08),
      width: Math.round(pageInfo.width * 0.84),
      height: Math.round(pageInfo.height * 0.84),
    };

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

    // Bind mousedown for crop handles
    g.querySelectorAll("[data-handle]").forEach((handleEl) => {
      handleEl.addEventListener("mousedown", (e: any) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        e.preventDefault();

        const handleType = handleEl.getAttribute("data-handle");
        if (!handleType) return;

        const rect = svg.getBoundingClientRect();
        const scaleX = pageInfo.width / rect.width;
        const scaleY = pageInfo.height / rect.height;
        const pt = {
          x: (e.clientX - rect.left) * scaleX,
          y: (e.clientY - rect.top) * scaleY,
        };

        this.cropDragHandle = handleType;
        this.cropStartPt = pt;
        this.cropStartBox = { ...box };
        this.cropStartRatio = box.width / Math.max(1, box.height);
      });
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
          ${isLocked ? `🔒 Fixed Ratio (${(box.width / Math.max(1, box.height)).toFixed(2)})` : "Free Ratio (Hold Ctrl to Lock)"}
        </span>
        <div class="crop-hud-actions">
          <button class="btn btn-sm btn-primary py-0 px-2 fw-medium" id="hud-crop-apply">Apply (Enter)</button>
          <button class="btn btn-sm btn-outline-secondary py-0 px-2 text-white" id="hud-crop-cancel">Cancel (Esc)</button>
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

      if (editorState.activeTool === "crop") {
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

    // Window mousemove for handle dragging
    window.addEventListener("mousemove", (e) => {
      if (!this.cropDragHandle || !this.cropStartPt || !this.cropStartBox || !editorState.doc) {
        return;
      }

      const doc = editorState.doc;
      const pageInfo = doc.pages[this.cropActivePage];
      if (!pageInfo) return;

      const pageEl = document.querySelector(`#pdf-page-${this.cropActivePage} svg`);
      if (!pageEl) return;

      const rect = pageEl.getBoundingClientRect();
      const scaleX = pageInfo.width / rect.width;
      const scaleY = pageInfo.height / rect.height;
      const curPt = {
        x: (e.clientX - rect.left) * scaleX,
        y: (e.clientY - rect.top) * scaleY,
      };

      const dx = curPt.x - this.cropStartPt.x;
      const dy = curPt.y - this.cropStartPt.y;

      const lockRatio = e.ctrlKey || this.isCtrlHeld || editorState.toolSettings.cropRatioMode !== "free";
      let targetRatio = this.cropStartRatio;
      if (editorState.toolSettings.cropRatioMode === "1:1") targetRatio = 1.0;
      else if (editorState.toolSettings.cropRatioMode === "4:3") targetRatio = 4 / 3;
      else if (editorState.toolSettings.cropRatioMode === "16:9") targetRatio = 16 / 9;
      else if (editorState.toolSettings.cropRatioMode === "original") targetRatio = pageInfo.width / pageInfo.height;

      const sb = this.cropStartBox;
      let newBox: PageBox = { ...sb };

      if (this.cropDragHandle === "move") {
        newBox.x = Math.max(0, Math.min(pageInfo.width - sb.width, sb.x + dx));
        newBox.y = Math.max(0, Math.min(pageInfo.height - sb.height, sb.y + dy));
      } else if (this.cropDragHandle === "se") {
        // Anchor is top-left (sb.x, sb.y)
        let w = Math.max(24, sb.width + dx);
        let h = Math.max(24, sb.height + dy);
        if (lockRatio) {
          if (Math.abs(dx) >= Math.abs(dy)) h = w / targetRatio;
          else w = h * targetRatio;
        }
        w = Math.min(w, pageInfo.width - sb.x);
        h = Math.min(h, pageInfo.height - sb.y);
        if (lockRatio) {
          if (w / h > targetRatio) w = h * targetRatio;
          else h = w / targetRatio;
        }
        newBox = { x: sb.x, y: sb.y, width: w, height: h };
      } else if (this.cropDragHandle === "sw") {
        // Anchor is top-right (sb.x + sb.width, sb.y)
        const anchorX = sb.x + sb.width;
        let w = Math.max(24, sb.width - dx);
        let h = Math.max(24, sb.height + dy);
        if (lockRatio) {
          if (Math.abs(dx) >= Math.abs(dy)) h = w / targetRatio;
          else w = h * targetRatio;
        }
        w = Math.min(w, anchorX);
        h = Math.min(h, pageInfo.height - sb.y);
        if (lockRatio) {
          if (w / h > targetRatio) w = h * targetRatio;
          else h = w / targetRatio;
        }
        newBox = { x: anchorX - w, y: sb.y, width: w, height: h };
      } else if (this.cropDragHandle === "ne") {
        // Anchor is bottom-left (sb.x, sb.y + sb.height)
        const anchorY = sb.y + sb.height;
        let w = Math.max(24, sb.width + dx);
        let h = Math.max(24, sb.height - dy);
        if (lockRatio) {
          if (Math.abs(dx) >= Math.abs(dy)) h = w / targetRatio;
          else w = h * targetRatio;
        }
        w = Math.min(w, pageInfo.width - sb.x);
        h = Math.min(h, anchorY);
        if (lockRatio) {
          if (w / h > targetRatio) w = h * targetRatio;
          else h = w / targetRatio;
        }
        newBox = { x: sb.x, y: anchorY - h, width: w, height: h };
      } else if (this.cropDragHandle === "nw") {
        // Anchor is bottom-right (sb.x + sb.width, sb.y + sb.height)
        const anchorX = sb.x + sb.width;
        const anchorY = sb.y + sb.height;
        let w = Math.max(24, sb.width - dx);
        let h = Math.max(24, sb.height - dy);
        if (lockRatio) {
          if (Math.abs(dx) >= Math.abs(dy)) h = w / targetRatio;
          else w = h * targetRatio;
        }
        w = Math.min(w, anchorX);
        h = Math.min(h, anchorY);
        if (lockRatio) {
          if (w / h > targetRatio) w = h * targetRatio;
          else h = w / targetRatio;
        }
        newBox = { x: anchorX - w, y: anchorY - h, width: w, height: h };
      } else if (this.cropDragHandle === "n") {
        const anchorY = sb.y + sb.height;
        let h = Math.max(24, Math.min(anchorY, sb.height - dy));
        let w = sb.width;
        let x = sb.x;
        if (lockRatio) {
          w = h * targetRatio;
          x = Math.max(0, Math.min(pageInfo.width - w, sb.x + (sb.width - w) / 2));
        }
        newBox = { x, y: anchorY - h, width: w, height: h };
      } else if (this.cropDragHandle === "s") {
        let h = Math.max(24, Math.min(pageInfo.height - sb.y, sb.height + dy));
        let w = sb.width;
        let x = sb.x;
        if (lockRatio) {
          w = h * targetRatio;
          x = Math.max(0, Math.min(pageInfo.width - w, sb.x + (sb.width - w) / 2));
        }
        newBox = { x, y: sb.y, width: w, height: h };
      } else if (this.cropDragHandle === "w") {
        const anchorX = sb.x + sb.width;
        let w = Math.max(24, Math.min(anchorX, sb.width - dx));
        let h = sb.height;
        let y = sb.y;
        if (lockRatio) {
          h = w / targetRatio;
          y = Math.max(0, Math.min(pageInfo.height - h, sb.y + (sb.height - h) / 2));
        }
        newBox = { x: anchorX - w, y, width: w, height: h };
      } else if (this.cropDragHandle === "e") {
        let w = Math.max(24, Math.min(pageInfo.width - sb.x, sb.width + dx));
        let h = sb.height;
        let y = sb.y;
        if (lockRatio) {
          h = w / targetRatio;
          y = Math.max(0, Math.min(pageInfo.height - h, sb.y + (sb.height - h) / 2));
        }
        newBox = { x: sb.x, y, width: w, height: h };
      }

      editorState.setCropBox(newBox);
    });

    window.addEventListener("mouseup", () => {
      this.cropDragHandle = null;
      this.cropStartPt = null;
      this.cropStartBox = null;
    });
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
        tag.textContent = `🔒 Fixed Ratio (${ratio})`;
      } else {
        tag.classList.remove("locked");
        tag.textContent = "Free Ratio (Hold Ctrl to Lock)";
      }
    }
  }

  async applyActiveCrop() {
    if (!editorState.cropBox || !editorState.doc) return;
    try {
      const updated = await Backend.cropPages([editorState.currentPage], editorState.cropBox);
      editorState.setDocument(updated);
      editorState.setTool("select");
      toast.show({
        message: `Crop applied to page ${editorState.currentPage + 1}`,
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

  private bindDrawingOnSvg(svg: SVGSVGElement, pageIndex: number, pageInfo: PageInfo) {
    const getPdfCoords = (e: MouseEvent): { x: number; y: number } => {
      const rect = svg.getBoundingClientRect();
      const scaleX = pageInfo.width / rect.width;
      const scaleY = pageInfo.height / rect.height;
      return {
        x: (e.clientX - rect.left) * scaleX,
        y: (e.clientY - rect.top) * scaleY,
      };
    };

    svg.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return; // Primary button only
      const tool = editorState.activeTool;
      if (tool === "hand" || tool === "select" || tool === "crop") return;

      this.isDrawing = true;
      this.activePageForDraw = pageIndex;
      this.currentSvgOverlay = svg;
      const pt = getPdfCoords(e);
      this.startPoint = pt;
      this.activeDrawPath = [pt];
    });

    svg.addEventListener("mousemove", (e) => {
      if (!this.isDrawing || !this.startPoint || this.currentSvgOverlay !== svg) return;
      const pt = getPdfCoords(e);
      const tool = editorState.activeTool;

      if (tool === "pen" || tool === "highlighter") {
        if (e.shiftKey && this.activeDrawPath.length > 0) {
          const first = this.activeDrawPath[0];
          this.activeDrawPath = [first, pt];
        } else {
          this.activeDrawPath.push(pt);
        }
        this.renderLivePenPath(svg, this.activeDrawPath, tool);
      } else if (
        tool === "rectangle" ||
        tool === "circle" ||
        tool === "line" ||
        tool === "arrow" ||
        tool === "coverErase" ||
        tool === "trueRedact" ||
        tool === "highlight"
      ) {
        this.renderLiveShapePreview(svg, this.startPoint, pt, tool);
      }
    });

    const handlePointerUp = async (e: MouseEvent) => {
      if (!this.isDrawing || !this.startPoint || this.currentSvgOverlay !== svg) return;
      this.isDrawing = false;
      const endPoint = getPdfCoords(e);
      const tool = editorState.activeTool;

      svg.querySelectorAll(".temp-draw-preview").forEach((el) => el.remove());

      const x = Math.min(this.startPoint.x, endPoint.x);
      const y = Math.min(this.startPoint.y, endPoint.y);
      const width = Math.abs(endPoint.x - this.startPoint.x);
      const height = Math.abs(endPoint.y - this.startPoint.y);

      const rect: PageBox = { x, y, width: Math.max(width, 2), height: Math.max(height, 2) };

      if (tool === "coverErase") {
        try {
          const updated = await Backend.coverErase(pageIndex, rect, editorState.toolSettings.coverColor);
          editorState.setDocument(updated);
          toast.show({ message: "Applied cover overlay", type: "info" });
        } catch (err: any) {
          toast.show({ message: err.toString(), type: "error" });
        }
      } else if (tool === "trueRedact") {
        try {
          const updated = await Backend.trueRedact(pageIndex, rect);
          editorState.setDocument(updated);
          toast.show({ message: "True redaction applied. Underlying text scrubbed.", type: "warning" });
        } catch (err: any) {
          toast.show({ message: err.toString(), type: "error" });
        }
      } else if (tool === "pen" || tool === "highlighter") {
        if (this.activeDrawPath.length > 1) {
          const annot: AnnotationDto = {
            id: `ink-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
            page_index: pageIndex,
            annot_type: "Ink",
            rect: {
              x: Math.min(...this.activeDrawPath.map((p) => p.x)),
              y: Math.min(...this.activeDrawPath.map((p) => p.y)),
              width: Math.max(...this.activeDrawPath.map((p) => p.x)) - Math.min(...this.activeDrawPath.map((p) => p.x)),
              height: Math.max(...this.activeDrawPath.map((p) => p.y)) - Math.min(...this.activeDrawPath.map((p) => p.y)),
            },
            color: tool === "highlighter" ? "#ffff00" : editorState.toolSettings.strokeColor,
            fill_color: null,
            stroke_width: tool === "highlighter" ? 12 : editorState.toolSettings.strokeWidth,
            opacity: tool === "highlighter" ? 0.4 : editorState.toolSettings.opacity,
            text: null,
            points: [this.activeDrawPath],
            author: editorState.toolSettings.author,
            modified_date: new Date().toISOString(),
            locked: false,
          };
          try {
            const updated = await Backend.addAnnotation(annot);
            editorState.setDocument(updated);
          } catch (err: any) {
            console.error("Failed to add ink annot:", err);
          }
        }
      } else if (tool === "rectangle" || tool === "circle" || tool === "line" || tool === "highlight") {
        const annotType = tool === "rectangle" ? "Square" : tool === "circle" ? "Circle" : tool === "line" ? "Line" : "Highlight";
        const annot: AnnotationDto = {
          id: `${tool}-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
          page_index: pageIndex,
          annot_type: annotType,
          rect,
          color: tool === "highlight" ? "#ffff00" : editorState.toolSettings.strokeColor,
          fill_color: tool === "highlight" ? "#ffff00" : editorState.toolSettings.fillColor,
          stroke_width: tool === "highlight" ? 1 : editorState.toolSettings.strokeWidth,
          opacity: tool === "highlight" ? 0.4 : editorState.toolSettings.opacity,
          text: null,
          points: null,
          author: editorState.toolSettings.author,
          modified_date: new Date().toISOString(),
          locked: false,
        };
        try {
          const updated = await Backend.addAnnotation(annot);
          editorState.setDocument(updated);
        } catch (err: any) {
          console.error("Failed to add shape annot:", err);
        }
      } else if (tool === "freeText") {
        const text = prompt("Enter text for box:", "Type here...");
        if (text) {
          const annot: AnnotationDto = {
            id: `freetext-${Date.now()}`,
            page_index: pageIndex,
            annot_type: "FreeText",
            rect: { x: this.startPoint.x, y: this.startPoint.y, width: 160, height: 32 },
            color: editorState.toolSettings.strokeColor,
            fill_color: null,
            stroke_width: 1,
            opacity: 1.0,
            text,
            points: null,
            author: editorState.toolSettings.author,
            modified_date: new Date().toISOString(),
            locked: false,
          };
          const updated = await Backend.addAnnotation(annot);
          editorState.setDocument(updated);
        }
      }

      this.startPoint = null;
      this.activeDrawPath = [];
    };

    svg.addEventListener("mouseup", handlePointerUp);
  }

  private renderLivePenPath(svg: SVGSVGElement, pts: { x: number; y: number }[], tool: string) {
    let preview = svg.querySelector(".temp-draw-preview") as SVGPathElement | null;
    if (!preview) {
      preview = document.createElementNS("http://www.w3.org/2000/svg", "path");
      preview.setAttribute("class", "temp-draw-preview");
      preview.setAttribute("fill", "none");
      preview.setAttribute("stroke-linecap", "round");
      preview.setAttribute("stroke-linejoin", "round");
      svg.appendChild(preview);
    }

    const stroke = tool === "highlighter" ? "#ffff00" : editorState.toolSettings.strokeColor;
    const width = tool === "highlighter" ? "12" : editorState.toolSettings.strokeWidth.toString();
    const opacity = tool === "highlighter" ? "0.4" : editorState.toolSettings.opacity.toString();

    preview.setAttribute("stroke", stroke);
    preview.setAttribute("stroke-width", width);
    preview.setAttribute("opacity", opacity);

    if (pts.length < 2) return;
    let d = `M ${pts[0].x} ${pts[0].y}`;
    for (let i = 1; i < pts.length; i++) {
      d += ` L ${pts[i].x} ${pts[i].y}`;
    }
    preview.setAttribute("d", d);
  }

  private renderLiveShapePreview(
    svg: SVGSVGElement,
    p1: { x: number; y: number },
    p2: { x: number; y: number },
    tool: string
  ) {
    let preview = svg.querySelector(".temp-draw-preview");
    if (!preview) {
      preview = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      preview.setAttribute("class", "temp-draw-preview");
      svg.appendChild(preview);
    }

    const x = Math.min(p1.x, p2.x);
    const y = Math.min(p1.y, p2.y);
    const w = Math.abs(p2.x - p1.x);
    const h = Math.abs(p2.y - p1.y);

    if (tool === "trueRedact") {
      preview.setAttribute("x", x.toString());
      preview.setAttribute("y", y.toString());
      preview.setAttribute("width", w.toString());
      preview.setAttribute("height", h.toString());
      preview.setAttribute("fill", "#000000");
      preview.setAttribute("stroke", "#dc2626");
      preview.setAttribute("stroke-width", "2");
      preview.setAttribute("stroke-dasharray", "4 4");
    } else if (tool === "coverErase") {
      preview.setAttribute("x", x.toString());
      preview.setAttribute("y", y.toString());
      preview.setAttribute("width", w.toString());
      preview.setAttribute("height", h.toString());
      preview.setAttribute("fill", editorState.toolSettings.coverColor);
      preview.setAttribute("stroke", "#3b82f6");
      preview.setAttribute("stroke-width", "1");
    } else {
      preview.setAttribute("x", x.toString());
      preview.setAttribute("y", y.toString());
      preview.setAttribute("width", w.toString());
      preview.setAttribute("height", h.toString());
      preview.setAttribute("fill", editorState.toolSettings.fillColor || "none");
      preview.setAttribute("stroke", editorState.toolSettings.strokeColor);
      preview.setAttribute("stroke-width", editorState.toolSettings.strokeWidth.toString());
    }
  }

  private bindViewportEvents() {
    this.element.addEventListener(
      "wheel",
      (e) => {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          if (e.deltaY < 0) {
            editorState.zoomIn();
          } else {
            editorState.zoomOut();
          }
        }
      },
      { passive: false }
    );

    window.addEventListener("jump-to-page", (e: any) => {
      const idx = e.detail?.pageIndex;
      if (typeof idx === "number") {
        const target = this.element.querySelector(`#pdf-page-${idx}`);
        target?.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    });
  }
}
