import { Calendar, Check, Eraser, Image as ImageIcon, PenTool, Stamp, Upload, X } from "lucide";
import { editorState } from "../state/editorState";
import { toast } from "./Toast";
import { icon } from "./ui/icon";

export interface PendingPlacement {
  imageBase64: string;
  width: number;
  height: number;
  opacity: number;
  label: string;
}

type ModalTab = "draw" | "upload" | "stamp";

const INK_COLORS = ["#111827", "#1e3a8a", "#2563eb", "#dc2626"];
const STAMP_PRESETS = ["APPROVED", "DRAFT", "CONFIDENTIAL", "FINAL", "REVISED", "REVIEWED"];
const STAMP_COLORS = ["#16a34a", "#dc2626", "#2563eb", "#d97706", "#252524"];

let currentPlacement: PendingPlacement | null = null;
let singletonModal: SignatureModalView | null = null;

export function getPendingPlacement(): PendingPlacement | null {
  return currentPlacement;
}

export function setPendingPlacement(placement: PendingPlacement | null): void {
  currentPlacement = placement;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("pending-placement-changed", { detail: placement }));
  }
}

export function clearPendingPlacement(): void {
  if (currentPlacement) {
    setPendingPlacement(null);
  }
}

/** Trim transparent outer margins of a drawing canvas and export a PNG data URL. */
function trimCanvasToPng(canvas: HTMLCanvasElement): { dataUrl: string; width: number; height: number } | null {
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const { width, height } = canvas;
  const { data } = ctx.getImageData(0, 0, width, height);

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) return null;

  const pad = 8;
  const sx = Math.max(0, minX - pad);
  const sy = Math.max(0, minY - pad);
  const sw = Math.min(width - sx, maxX - minX + 1 + pad * 2);
  const sh = Math.min(height - sy, maxY - minY + 1 + pad * 2);

  const out = document.createElement("canvas");
  out.width = sw;
  out.height = sh;
  out.getContext("2d")!.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
  return { dataUrl: out.toDataURL("image/png"), width: sw, height: sh };
}

/** Rasterize any uploaded PNG/JPEG/SVG file into a PNG data URL with intrinsic dimensions. */
async function rasterizeImageFile(file: File): Promise<{ dataUrl: string; width: number; height: number }> {
  const rawUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read image file."));
    reader.readAsDataURL(file);
  });

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("Unsupported or corrupt image file."));
    el.src = rawUrl;
  });

  const natW = img.naturalWidth || 320;
  const natH = img.naturalHeight || 120;
  const maxDim = 900;
  const scale = Math.min(1, maxDim / Math.max(natW, natH));
  const targetW = Math.max(16, Math.round(natW * (file.type === "image/svg+xml" && Math.max(natW, natH) < 300 ? 2 : scale)));
  const targetH = Math.max(16, Math.round(natH * (targetW / natW)));

  const canvas = document.createElement("canvas");
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0, targetW, targetH);

  return {
    dataUrl: canvas.toDataURL("image/png"),
    width: targetW,
    height: targetH,
  };
}

/** Render a crisp vector-styled custom text/date stamp into a PNG data URL. */
export function renderStampToPng(
  text: string,
  color: string,
  includeDate: boolean,
  includeAuthor: boolean,
  author: string,
): { dataUrl: string; width: number; height: number } {
  const label = (text.trim() || "APPROVED").toUpperCase();
  const dateText = includeDate ? new Date().toISOString().slice(0, 10) : "";
  const subParts = [dateText, includeAuthor && author.trim() ? author.trim() : ""].filter(Boolean);
  const subLine = subParts.join(" · ");

  const scale = 3;
  const probe = document.createElement("canvas").getContext("2d")!;
  probe.font = "800 22px Manrope, sans-serif";
  const labelWidth = probe.measureText(label).width;
  probe.font = "600 11px Manrope, sans-serif";
  const subWidth = subLine ? probe.measureText(subLine).width : 0;

  const logicalW = Math.max(130, Math.ceil(Math.max(labelWidth, subWidth) + 34));
  const logicalH = subLine ? 56 : 42;

  const canvas = document.createElement("canvas");
  canvas.width = logicalW * scale;
  canvas.height = logicalH * scale;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(scale, scale);

  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
  roundRect(ctx, 2, 2, logicalW - 4, logicalH - 4, 6);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "800 22px Manrope, sans-serif";
  ctx.fillText(label, logicalW / 2, subLine ? 20 : logicalH / 2);

  if (subLine) {
    ctx.font = "600 11px Manrope, sans-serif";
    ctx.fillText(subLine, logicalW / 2, 41);
  }

  return { dataUrl: canvas.toDataURL("image/png"), width: logicalW, height: logicalH };
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

export class SignatureModalView {
  private dialog: HTMLDialogElement;
  private activeTab: ModalTab = "draw";
  private inkColor = "#111827";
  private inkWidth = 2.5;
  private hasDrawn = false;
  private uploadedImage: { dataUrl: string; width: number; height: number; name: string } | null = null;
  private stampText = editorState.toolSettings.stampText || "APPROVED";
  private stampColor = "#16a34a";
  private stampIncludeDate = true;
  private stampIncludeAuthor = false;
  private drawing = false;
  private lastPt: { x: number; y: number } | null = null;
  private focusReturn: HTMLElement | null = null;

  constructor() {
    this.dialog = document.createElement("dialog");
    this.dialog.className = "rounded-lg border border-border bg-popover text-popover-foreground shadow-lg p-0 max-w-lg w-[calc(100vw-32px)] m-auto";
    this.dialog.setAttribute("aria-modal", "true");
    this.dialog.setAttribute("aria-label", "Signature and Stamp");
    this.dialog.style.backdropFilter = "blur(2px)";
    document.body.appendChild(this.dialog);

    window.addEventListener("open-signature", () => this.open());
    this.dialog.addEventListener("close", () => {
      if (this.focusReturn?.isConnected) {
        this.focusReturn.focus({ preventScroll: true });
      }
    });
  }

  open(initialTab?: ModalTab) {
    if (!editorState.doc || editorState.openingFile) {
      toast.show({ message: "Open a PDF document before adding a signature or stamp.", type: "warning" });
      return;
    }
    if (initialTab) this.activeTab = initialTab;
    this.stampText = editorState.toolSettings.stampText || this.stampText || "APPROVED";
    this.focusReturn = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.render();
    if (!this.dialog.open) {
      this.dialog.showModal();
    }
    this.initPadCanvas();
  }

  close() {
    if (this.dialog.open) this.dialog.close();
  }

  private render() {
    const tabBtn = (tab: ModalTab, label: string, svgIcon: string) => `
      <button type="button"
        class="ui-button ui-button--tool flex-1 ${this.activeTab === tab ? "active" : ""}"
        data-sig-tab="${tab}"
        aria-pressed="${this.activeTab === tab}">
        ${svgIcon}
        <span>${label}</span>
      </button>`;

    this.dialog.innerHTML = `
      <div class="flex flex-col">
        <div class="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 class="text-base font-semibold m-0">Signature & Stamp</h2>
          <button type="button" class="ui-button ui-button--tool" id="sig-close" aria-label="Close">
            ${icon(X)}
          </button>
        </div>

        <div class="flex gap-1 px-4 pt-3">
          ${tabBtn("draw", "Draw Signature", icon(PenTool))}
          ${tabBtn("upload", "Upload Image", icon(ImageIcon))}
          ${tabBtn("stamp", "Custom Stamp", icon(Stamp))}
        </div>

        <div class="p-4 flex flex-col gap-3">
          ${this.renderTabBody()}
        </div>

        <div class="flex items-center justify-end gap-2 px-4 py-3 border-t border-border bg-card">
          <button type="button" class="ui-button ui-button--outline ui-button--sm" id="sig-cancel">Cancel</button>
          <button type="button" class="ui-button ui-button--default ui-button--sm" id="sig-place">
            ${icon(Check, 14)}
            <span>Place on Page</span>
          </button>
        </div>
      </div>
    `;

    this.bindEvents();
  }

  private renderTabBody(): string {
    if (this.activeTab === "draw") {
      return `
        <div class="flex items-center justify-between gap-2 flex-wrap">
          <div class="flex items-center gap-1.5">
            <span class="text-xs text-muted-foreground">Ink</span>
            ${INK_COLORS.map(
              (c) => `<button type="button" class="color-swatch ${c === this.inkColor ? "active" : ""}" data-ink="${c}" style="background:${c};width:20px;height:20px;" aria-label="Ink color ${c}"></button>`,
            ).join("")}
            <input type="color" class="ui-input ui-color" id="sig-ink-picker" value="${this.inkColor}" aria-label="Custom ink color" />
          </div>
          <div class="flex items-center gap-2">
            <label class="text-xs text-muted-foreground" for="sig-ink-width">Pen</label>
            <input type="range" class="ui-slider" style="width:84px;" id="sig-ink-width" min="1" max="6" step="0.5" value="${this.inkWidth}" />
            <button type="button" class="ui-button ui-button--outline ui-button--sm" id="sig-pad-clear">
              ${icon(Eraser, 14)}
              <span>Clear</span>
            </button>
          </div>
        </div>
        <div class="relative rounded-md border border-border overflow-hidden" style="background:#ffffff;height:180px;">
          <canvas id="sig-pad-canvas" class="w-full h-full block" style="touch-action:none;cursor:crosshair;"></canvas>
          <span id="sig-pad-hint" class="pointer-events-none absolute inset-0 flex items-center justify-center text-xs" style="color:#6b7280;${this.hasDrawn ? "display:none;" : ""}">
            Sign here with mouse, pen, or touch
          </span>
        </div>
      `;
    }

    if (this.activeTab === "upload") {
      return `
        <div class="flex flex-col gap-2">
          <label class="text-xs text-muted-foreground">Upload a PNG, SVG, or JPEG signature or stamp image</label>
          <div class="flex items-center gap-2">
            <input type="file" id="sig-file-input" accept=".png,.svg,.jpg,.jpeg,image/png,image/svg+xml,image/jpeg" class="hidden" />
            <button type="button" class="ui-button ui-button--outline ui-button--sm" id="sig-file-btn">
              ${icon(Upload, 14)}
              <span>Choose PNG / SVG...</span>
            </button>
            <span class="text-xs text-muted-foreground truncate">
              ${this.uploadedImage ? `${this.uploadedImage.name} (${this.uploadedImage.width} × ${this.uploadedImage.height}px)` : "No file selected"}
            </span>
          </div>
          <div class="rounded-md border border-border flex items-center justify-center p-3" style="background:#ffffff;min-height:140px;">
            ${
              this.uploadedImage
                ? `<img src="${this.uploadedImage.dataUrl}" alt="Uploaded signature preview" style="max-height:124px;max-width:100%;object-fit:contain;" />`
                : `<span class="text-xs" style="color:#6b7280;">Image preview will appear here</span>`
            }
          </div>
        </div>
      `;
    }

    // Custom stamp tab
    const preview = renderStampToPng(
      this.stampText,
      this.stampColor,
      this.stampIncludeDate,
      this.stampIncludeAuthor,
      editorState.toolSettings.author || "",
    );

    return `
      <div class="flex flex-col gap-3">
        <div>
          <label class="property-label block mb-1">Presets</label>
          <div class="flex flex-wrap gap-1.5">
            ${STAMP_PRESETS.map(
              (preset) => `<button type="button" class="ui-button ui-button--outline ui-button--sm ${this.stampText.toUpperCase() === preset ? "bg-accent text-accent-foreground" : ""}" data-stamp-preset="${preset}">${preset}</button>`,
            ).join("")}
          </div>
        </div>

        <div class="grid grid-cols-[1fr_auto] gap-2 items-end">
          <div>
            <label class="property-label block mb-1" for="sig-stamp-text">Stamp Text</label>
            <input type="text" class="ui-input" id="sig-stamp-text" value="${escapeAttr(this.stampText)}" maxlength="40" placeholder="Enter stamp text" />
          </div>
          <div class="flex items-center gap-1">
            ${STAMP_COLORS.map(
              (c) => `<button type="button" class="color-swatch ${c === this.stampColor ? "active" : ""}" data-stamp-color="${c}" style="background:${c};width:22px;height:22px;" aria-label="Stamp color ${c}"></button>`,
            ).join("")}
          </div>
        </div>

        <div class="flex items-center gap-4 flex-wrap">
          <label class="ui-check text-xs">
            <input type="checkbox" id="sig-stamp-date" ${this.stampIncludeDate ? "checked" : ""} />
            ${icon(Calendar, 13)}
            <span>Include date (${new Date().toISOString().slice(0, 10)})</span>
          </label>
          <label class="ui-check text-xs">
            <input type="checkbox" id="sig-stamp-author" ${this.stampIncludeAuthor ? "checked" : ""} />
            <span>Include author (${escapeHtml(editorState.toolSettings.author || "User")})</span>
          </label>
        </div>

        <div class="rounded-md border border-border flex items-center justify-center p-3" style="background:var(--workspace);min-height:84px;">
          <img id="sig-stamp-preview" src="${preview.dataUrl}" alt="Stamp preview" style="max-height:68px;max-width:100%;object-fit:contain;" />
        </div>
      </div>
    `;
  }

  private bindEvents() {
    this.dialog.querySelector("#sig-close")?.addEventListener("click", () => this.close());
    this.dialog.querySelector("#sig-cancel")?.addEventListener("click", () => this.close());

    this.dialog.querySelectorAll<HTMLButtonElement>("[data-sig-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const next = btn.dataset.sigTab as ModalTab;
        if (next && next !== this.activeTab) {
          this.activeTab = next;
          this.render();
          if (this.activeTab === "draw") this.initPadCanvas();
        }
      });
    });

    if (this.activeTab === "draw") {
      this.dialog.querySelectorAll<HTMLButtonElement>("[data-ink]").forEach((btn) => {
        btn.addEventListener("click", () => {
          this.inkColor = btn.dataset.ink!;
          const picker = this.dialog.querySelector<HTMLInputElement>("#sig-ink-picker");
          if (picker) picker.value = this.inkColor;
          this.dialog.querySelectorAll("[data-ink]").forEach((el) => el.classList.toggle("active", el === btn));
        });
      });
      const picker = this.dialog.querySelector<HTMLInputElement>("#sig-ink-picker");
      picker?.addEventListener("change", () => {
        this.inkColor = picker.value;
      });
      const widthInput = this.dialog.querySelector<HTMLInputElement>("#sig-ink-width");
      widthInput?.addEventListener("input", () => {
        this.inkWidth = widthInput.valueAsNumber || 2.5;
      });
      this.dialog.querySelector("#sig-pad-clear")?.addEventListener("click", () => {
        this.hasDrawn = false;
        this.initPadCanvas(true);
      });
    } else if (this.activeTab === "upload") {
      const fileInput = this.dialog.querySelector<HTMLInputElement>("#sig-file-input");
      this.dialog.querySelector("#sig-file-btn")?.addEventListener("click", () => fileInput?.click());
      fileInput?.addEventListener("change", async () => {
        const file = fileInput.files?.[0];
        if (!file) return;
        try {
          const raster = await rasterizeImageFile(file);
          this.uploadedImage = { ...raster, name: file.name };
          this.render();
        } catch (err) {
          toast.show({ message: String(err), type: "error" });
        }
      });
    } else if (this.activeTab === "stamp") {
      const textInput = this.dialog.querySelector<HTMLInputElement>("#sig-stamp-text");
      const dateCheck = this.dialog.querySelector<HTMLInputElement>("#sig-stamp-date");
      const authorCheck = this.dialog.querySelector<HTMLInputElement>("#sig-stamp-author");
      const updatePreview = () => {
        const img = this.dialog.querySelector<HTMLImageElement>("#sig-stamp-preview");
        if (!img) return;
        img.src = renderStampToPng(
          this.stampText,
          this.stampColor,
          this.stampIncludeDate,
          this.stampIncludeAuthor,
          editorState.toolSettings.author || "",
        ).dataUrl;
      };

      this.dialog.querySelectorAll<HTMLButtonElement>("[data-stamp-preset]").forEach((btn) => {
        btn.addEventListener("click", () => {
          this.stampText = btn.dataset.stampPreset || "APPROVED";
          if (textInput) textInput.value = this.stampText;
          updatePreview();
        });
      });

      this.dialog.querySelectorAll<HTMLButtonElement>("[data-stamp-color]").forEach((btn) => {
        btn.addEventListener("click", () => {
          this.stampColor = btn.dataset.stampColor || "#16a34a";
          this.dialog.querySelectorAll("[data-stamp-color]").forEach((el) => el.classList.toggle("active", el === btn));
          updatePreview();
        });
      });

      textInput?.addEventListener("input", () => {
        this.stampText = textInput.value;
        updatePreview();
      });
      dateCheck?.addEventListener("change", () => {
        this.stampIncludeDate = dateCheck.checked;
        updatePreview();
      });
      authorCheck?.addEventListener("change", () => {
        this.stampIncludeAuthor = authorCheck.checked;
        updatePreview();
      });
    }

    this.dialog.querySelector("#sig-place")?.addEventListener("click", () => this.commitPlacement());
  }

  private initPadCanvas(clearOnly = false) {
    if (this.activeTab !== "draw") return;
    const canvas = this.dialog.querySelector<HTMLCanvasElement>("#sig-pad-canvas");
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(300, Math.round((rect.width || 440) * dpr));
    const h = Math.max(140, Math.round((rect.height || 180) * dpr));
    if (clearOnly || canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      this.hasDrawn = false;
    }
    const ctx = canvas.getContext("2d")!;
    if (clearOnly) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    const hint = this.dialog.querySelector<HTMLElement>("#sig-pad-hint");
    if (hint) hint.style.display = this.hasDrawn ? "none" : "flex";

    const getPoint = (e: PointerEvent) => {
      const bounds = canvas.getBoundingClientRect();
      return {
        x: ((e.clientX - bounds.left) / Math.max(1, bounds.width)) * canvas.width,
        y: ((e.clientY - bounds.top) / Math.max(1, bounds.height)) * canvas.height,
      };
    };

    canvas.onpointerdown = (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      this.drawing = true;
      this.lastPt = getPoint(e);
      if (!this.hasDrawn) {
        this.hasDrawn = true;
        if (hint) hint.style.display = "none";
      }
      ctx.fillStyle = this.inkColor;
      ctx.beginPath();
      ctx.arc(this.lastPt.x, this.lastPt.y, (this.inkWidth * dpr) / 2, 0, Math.PI * 2);
      ctx.fill();
    };

    canvas.onpointermove = (e) => {
      if (!this.drawing || !this.lastPt) return;
      const pt = getPoint(e);
      ctx.strokeStyle = this.inkColor;
      ctx.lineWidth = this.inkWidth * dpr;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(this.lastPt.x, this.lastPt.y);
      ctx.lineTo(pt.x, pt.y);
      ctx.stroke();
      this.lastPt = pt;
    };

    const endStroke = () => {
      this.drawing = false;
      this.lastPt = null;
    };
    canvas.onpointerup = endStroke;
    canvas.onpointercancel = endStroke;
  }

  private commitPlacement() {
    let payload: { dataUrl: string; width: number; height: number } | null = null;
    let label = "Signature";
    let defaultWidthPt = 160;

    if (this.activeTab === "draw") {
      const canvas = this.dialog.querySelector<HTMLCanvasElement>("#sig-pad-canvas");
      if (!canvas || !this.hasDrawn) {
        toast.show({ message: "Please draw a signature first.", type: "warning" });
        return;
      }
      payload = trimCanvasToPng(canvas);
      if (!payload) {
        toast.show({ message: "Please draw a signature first.", type: "warning" });
        return;
      }
      label = "Signature";
    } else if (this.activeTab === "upload") {
      if (!this.uploadedImage) {
        toast.show({ message: "Please choose a PNG or SVG image first.", type: "warning" });
        return;
      }
      payload = this.uploadedImage;
      label = this.uploadedImage.name;
      defaultWidthPt = 180;
    } else {
      const clean = this.stampText.trim();
      if (!clean) {
        toast.show({ message: "Please enter stamp text.", type: "warning" });
        return;
      }
      editorState.updateToolSettings({ stampText: clean });
      payload = renderStampToPng(
        clean,
        this.stampColor,
        this.stampIncludeDate,
        this.stampIncludeAuthor,
        editorState.toolSettings.author || "",
      );
      label = `Stamp (${clean.toUpperCase()})`;
      defaultWidthPt = Math.min(200, Math.max(120, payload.width));
    }

    const aspect = payload.height / Math.max(1, payload.width);
    const width = defaultWidthPt;
    const height = Math.max(20, Math.round(width * aspect));

    setPendingPlacement({
      imageBase64: payload.dataUrl,
      width,
      height,
      opacity: editorState.toolSettings.opacity,
      label,
    });
    this.close();
    editorState.setTool("stamp");
    toast.show({ message: `Click on a page to place ${label}. Press Esc to cancel.`, type: "info" });
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escapeAttr(text: string): string {
  return escapeHtml(text);
}

export function initSignatureModal(): SignatureModalView | null {
  if (typeof document === "undefined") return null;
  if (!singletonModal) {
    singletonModal = new SignatureModalView();
  }
  return singletonModal;
}

if (typeof document !== "undefined") {
  initSignatureModal();
}
