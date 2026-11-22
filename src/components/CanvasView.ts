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

  constructor(element: HTMLElement) {
    this.element = element;
    this.element.className = "canvas-viewport";

    this.pagesContainer = document.createElement("div");
    this.pagesContainer.className = "canvas-pages-container";
    this.element.appendChild(this.pagesContainer);

    this.render();
    editorState.subscribe(() => this.render());
    this.bindViewportEvents();
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

    this.bindDrawingOnSvg(svg, pageIndex, pageInfo);

    return wrapper;
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
      if (tool === "hand" || tool === "select") return;

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
        // Hold shift to lock straight line
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
        tool === "highlight" ||
        tool === "crop"
      ) {
        this.renderLiveShapePreview(svg, this.startPoint, pt, tool);
      }
    });

    const handlePointerUp = async (e: MouseEvent) => {
      if (!this.isDrawing || !this.startPoint || this.currentSvgOverlay !== svg) return;
      this.isDrawing = false;
      const endPoint = getPdfCoords(e);
      const tool = editorState.activeTool;

      // Clear temporary rubber-band preview elements
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
      } else if (tool === "crop") {
        try {
          const updated = await Backend.cropPages([pageIndex], rect);
          editorState.setDocument(updated);
          toast.show({ message: `Crop applied to page ${pageIndex + 1}`, type: "info" });
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
    } else if (tool === "crop") {
      preview.setAttribute("x", x.toString());
      preview.setAttribute("y", y.toString());
      preview.setAttribute("width", w.toString());
      preview.setAttribute("height", h.toString());
      preview.setAttribute("fill", "rgba(59, 130, 246, 0.15)");
      preview.setAttribute("stroke", "#2563eb");
      preview.setAttribute("stroke-width", "2");
      preview.setAttribute("stroke-dasharray", "6 4");
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
    // Ctrl + Mouse Wheel for smooth zooming
    this.element.addEventListener("wheel", (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        if (e.deltaY < 0) {
          editorState.zoomIn();
        } else {
          editorState.zoomOut();
        }
      }
    }, { passive: false });

    // Jump to page event listener
    window.addEventListener("jump-to-page", (e: any) => {
      const idx = e.detail?.pageIndex;
      if (typeof idx === "number") {
        const target = this.element.querySelector(`#pdf-page-${idx}`);
        target?.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    });
  }
}
