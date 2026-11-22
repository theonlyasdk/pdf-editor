import { Wrench } from "lucide";
import { icon } from "./ui/icon";
import { STRINGS } from "../i18n/strings";
import { Backend } from "../ipc/backend";
import { editorState } from "../state/editorState";
import { toast } from "./Toast";

const RECENT_COLORS = [
  "#2563eb", // Royal blue
  "#ef4444", // Red
  "#16a34a", // Green
  "#d97706", // Amber
  "#9333ea", // Purple
  "#000000", // Black
  "#ffffff", // White
  "#ffff00", // Yellow highlight
];

export class PropertiesPanelView {
  private element: HTMLElement;
  private committingCropFields = false;
  private cropScope = "current";

  constructor(element: HTMLElement) {
    this.element = element;
    this.element.className = "properties-panel";
    this.render();
    editorState.subscribe(() => this.render());
  }

  render() {
    if (this.committingCropFields) return;
    if (editorState.activeTool !== "crop") this.cropScope = "current";
    if (!editorState.doc) {
      this.element.style.display = "none";
      return;
    }
    this.element.style.display = "flex";

    const tool = editorState.activeTool;
    const settings = editorState.toolSettings;

    let bodyHtml = "";

    if (tool === "pen" || tool === "highlighter") {
      bodyHtml = `
        <div class="property-group">
          <label class="property-label">${STRINGS.properties.strokeColor}</label>
          <div class="flex items-center gap-2">
            <input type="color" class="ui-input ui-color" id="prop-stroke-color" value="${settings.strokeColor}" />
            <span class="tabular-nums text-xs">${settings.strokeColor}</span>
          </div>
          <div class="color-presets mt-1">
            ${RECENT_COLORS.map(
              (c) => `<div class="color-swatch ${c === settings.strokeColor ? "active" : ""}" style="background:${c}" data-color="${c}"></div>`
            ).join("")}
          </div>
        </div>

        <div class="property-group">
          <label class="property-label">${STRINGS.properties.strokeWidth}: <span id="prop-stroke-val">${settings.strokeWidth}px</span></label>
          <input type="range" class="ui-slider" id="prop-stroke-width" min="1" max="24" value="${settings.strokeWidth}" />
        </div>

        <div class="property-group">
          <label class="property-label">${STRINGS.properties.opacity}: <span id="prop-opacity-val">${Math.round(settings.opacity * 100)}%</span></label>
          <input type="range" class="ui-slider" id="prop-opacity" min="0.1" max="1" step="0.05" value="${settings.opacity}" />
        </div>
      `;
    } else if (tool === "rectangle" || tool === "circle" || tool === "line" || tool === "arrow") {
      bodyHtml = `
        <div class="property-group">
          <label class="property-label">${STRINGS.properties.strokeColor}</label>
          <input type="color" class="ui-input ui-color" id="prop-stroke-color" value="${settings.strokeColor}" />
          <div class="color-presets mt-1">
            ${RECENT_COLORS.map(
              (c) => `<div class="color-swatch ${c === settings.strokeColor ? "active" : ""}" style="background:${c}" data-color="${c}"></div>`
            ).join("")}
          </div>
        </div>

        <div class="property-group">
          <label class="property-label">${STRINGS.properties.fillColor}</label>
          <div class="flex items-center gap-2">
            <input type="color" class="ui-input ui-color" id="prop-fill-color" value="${settings.fillColor || "#ffffff"}" />
            <div class="ui-check mb-0">
              <input class="" type="checkbox" id="prop-fill-transparent" ${!settings.fillColor ? "checked" : ""} />
              <label class="text-xs" for="prop-fill-transparent">Transparent</label>
            </div>
          </div>
        </div>

        <div class="property-group">
          <label class="property-label">${STRINGS.properties.strokeWidth}: <span id="prop-stroke-val">${settings.strokeWidth}px</span></label>
          <input type="range" class="ui-slider" id="prop-stroke-width" min="1" max="20" value="${settings.strokeWidth}" />
        </div>

        <div class="property-group">
          <label class="property-label">${STRINGS.properties.opacity}: <span id="prop-opacity-val">${Math.round(settings.opacity * 100)}%</span></label>
          <input type="range" class="ui-slider" id="prop-opacity" min="0.1" max="1" step="0.05" value="${settings.opacity}" />
        </div>
      `;
    } else if (tool === "freeText") {
      bodyHtml = `
        <div class="property-group">
          <label class="property-label">Text Color</label>
          <input type="color" class="ui-input ui-color" id="prop-stroke-color" value="${settings.strokeColor}" />
        </div>

        <div class="property-group">
          <label class="property-label">${STRINGS.properties.fontSize}: <span id="prop-font-size-val">${settings.fontSize}pt</span></label>
          <input type="range" class="ui-slider" id="prop-font-size" min="8" max="72" value="${settings.fontSize}" />
        </div>

        <div class="property-group">
          <label class="property-label">${STRINGS.properties.fontFamily}</label>
          <select class="ui-input" id="prop-font-family">
            <option value="Helvetica, Arial, sans-serif">Helvetica / Sans-Serif</option>
            <option value="'Times New Roman', Times, serif">Times New Roman</option>
            <option value="'Courier New', Courier, monospace">Courier / Monospace</option>
          </select>
        </div>
      `;
    } else if (tool === "coverErase") {
      bodyHtml = `
        <div class="property-group">
          <label class="property-label">Cover Fill Color</label>
          <div class="flex items-center gap-2 mb-2">
            <input type="color" class="ui-input ui-color" id="prop-cover-color" value="${settings.coverColor}" />
            <span class="text-xs text-muted-foreground">White by default</span>
          </div>
          <p class="text-xs text-muted-foreground">Drag a rectangle on the page to cover unwanted content visually.</p>
        </div>
      `;
    } else if (tool === "trueRedact") {
      bodyHtml = `
        <div class="property-group">
          <div class="ui-alert ui-alert--destructive py-2 px-3 text-xs mb-2">
            <strong>${STRINGS.redaction.title}</strong>
            <p class="mb-0 mt-1" style="font-size: 11px;">${STRINGS.redaction.warning}</p>
          </div>
          <label class="property-label">${STRINGS.redaction.targetText}</label>
          <input type="text" class="ui-input mb-2" id="prop-redact-keyword" placeholder="e.g. SECRET_SSN" />
          <button class="ui-button ui-button--destructive ui-button--sm w-full" id="btn-apply-text-redact">
            Scrub Matching Text on Page
          </button>
          <p class="text-xs text-muted-foreground mt-2" style="font-size: 11px;">
            Or drag a red bounding box directly over any content on the page to permanently excise it.
          </p>
        </div>
      `;
    } else if (tool === "crop") {
      const page = editorState.doc?.pages[editorState.currentPage] || { width: 612, height: 792, index: 0 };
      const box = editorState.cropBox || {
        x: Math.round(page.width * 0.08),
        y: Math.round(page.height * 0.08),
        width: Math.round(page.width * 0.84),
        height: Math.round(page.height * 0.84),
      };
      const ratioMode = settings.cropRatioMode;

      bodyHtml = `
        <div class="property-group">
          <div class="flex justify-between items-center mb-1">
            <label class="property-label mb-0">Aspect Ratio</label>
            <span class="ui-badge ${ratioMode !== "free" ? "ui-badge--accent" : ""}" style="font-size: 10px;">
              ${ratioMode !== "free" ? "Ratio Locked" : "Hold Ctrl to Lock"}
            </span>
          </div>
          <select class="ui-input" id="prop-crop-ratio">
            <option value="free" ${ratioMode === "free" ? "selected" : ""}>Free Ratio (Default)</option>
            <option value="original" ${ratioMode === "original" ? "selected" : ""}>Original Page Ratio (${(page.width / Math.max(1, page.height)).toFixed(2)})</option>
            <option value="1:1" ${ratioMode === "1:1" ? "selected" : ""}>Square (1:1)</option>
            <option value="4:3" ${ratioMode === "4:3" ? "selected" : ""}>Standard (4:3)</option>
            <option value="16:9" ${ratioMode === "16:9" ? "selected" : ""}>Widescreen (16:9)</option>
          </select>
          <div class="text-muted-foreground text-xs" style="font-size: 11px;">
            By default free resizing. Hold <kbd>Ctrl</kbd> while dragging handles to lock ratio.
          </div>
        </div>

        <div class="property-group">
          <label class="property-label">Crop Box Dimensions</label>
          <div class="grid grid-cols-2 gap-2">
            <div class="min-w-0">
              <label class="text-xs text-muted-foreground" style="font-size: 11px;">Width (pt)</label>
              <input type="number" class="ui-input" id="prop-crop-w" value="${Math.round(box.width)}" min="20" max="${Math.round(page.width)}" />
            </div>
            <div class="min-w-0">
              <label class="text-xs text-muted-foreground" style="font-size: 11px;">Height (pt)</label>
              <input type="number" class="ui-input" id="prop-crop-h" value="${Math.round(box.height)}" min="20" max="${Math.round(page.height)}" />
            </div>
            <div class="min-w-0">
              <label class="text-xs text-muted-foreground" style="font-size: 11px;">Left / X (pt)</label>
              <input type="number" class="ui-input" id="prop-crop-x" value="${Math.round(box.x)}" min="0" max="${Math.round(page.width)}" />
            </div>
            <div class="min-w-0">
              <label class="text-xs text-muted-foreground" style="font-size: 11px;">Top / Y (pt)</label>
              <input type="number" class="ui-input" id="prop-crop-y" value="${Math.round(box.y)}" min="0" max="${Math.round(page.height)}" />
            </div>
          </div>
        </div>

        <div class="property-group">
          <label class="property-label">Quick Presets</label>
          <div class="grid gap-1">
            <button class="ui-button ui-button--outline ui-button--sm text-start py-1" id="preset-trim-margins">
              Trim Margins (10% Margin)
            </button>
            <button class="ui-button ui-button--outline ui-button--sm text-start py-1" id="preset-fit-a4">
              A4 Format Fit
            </button>
            <button class="ui-button ui-button--outline ui-button--sm text-start py-1" id="preset-fit-letter">
              US Letter Format Fit
            </button>
            <button class="ui-button ui-button--outline ui-button--sm text-start py-1" id="preset-full-page">
              Reset to Full Page
            </button>
          </div>
        </div>

        <div class="property-group">
          <label class="property-label">Target Scope</label>
          <div class="ui-check">
            <input class="" type="radio" name="crop-scope" id="crop-scope-current" value="current" ${this.cropScope === "current" ? "checked" : ""} />
            <label class="text-xs" for="crop-scope-current">Current Page (Page ${page.index + 1})</label>
          </div>
          <div class="ui-check">
            <input class="" type="radio" name="crop-scope" id="crop-scope-selected" value="selected" ${this.cropScope === "selected" ? "checked" : ""} />
            <label class="text-xs" for="crop-scope-selected">Selected Pages (${editorState.selectedPages.size || 1})</label>
          </div>
          <div class="ui-check">
            <input class="" type="radio" name="crop-scope" id="crop-scope-all" value="all" ${this.cropScope === "all" ? "checked" : ""} />
            <label class="text-xs" for="crop-scope-all">All Pages in Document</label>
          </div>
        </div>

        <div class="grid gap-2 mt-2">
          <button class="ui-button ui-button--default ui-button--sm font-medium shadow-sm" id="btn-panel-crop-apply">
            Apply Crop (Enter)
          </button>
          <button class="ui-button ui-button--outline ui-button--sm" id="btn-panel-crop-cancel">
            Cancel (Esc)
          </button>
        </div>
      `;
    } else if (tool === "stamp") {
      bodyHtml = `
        <div class="property-group">
          <label class="property-label">${STRINGS.properties.stampType}</label>
          <select class="ui-input" id="prop-stamp-select">
            <option value="APPROVED">APPROVED</option>
            <option value="DRAFT">DRAFT</option>
            <option value="CONFIDENTIAL">CONFIDENTIAL</option>
            <option value="FINAL">FINAL</option>
            <option value="REVISED">REVISED</option>
          </select>
        </div>
      `;
    } else {
      bodyHtml = `
        <div class="text-center text-muted-foreground my-5">
          ${icon(Wrench, 24)}
          <p class="text-xs px-3">${STRINGS.properties.noSelection}</p>
        </div>
      `;
    }

    this.element.innerHTML = `
      <div class="panel-header">
        <span class="text-xs font-semibold">${STRINGS.properties.title}</span>
        <span class="ui-badge text-xs capitalize">${tool}</span>
      </div>
      <div class="panel-body">
        ${bodyHtml}
      </div>
    `;

    this.bindPanelEvents();
  }

  private bindPanelEvents() {
    // Stroke Color Picker
    const strokePicker = this.element.querySelector("#prop-stroke-color") as HTMLInputElement | null;
    strokePicker?.addEventListener("input", () => {
      editorState.updateToolSettings({ strokeColor: strokePicker.value });
    });

    // Swatches
    this.element.querySelectorAll(".color-swatch[data-color]").forEach((swatch) => {
      swatch.addEventListener("click", () => {
        const c = swatch.getAttribute("data-color");
        if (c) {
          editorState.updateToolSettings({ strokeColor: c });
        }
      });
    });

    // Stroke width slider
    const strokeSlider = this.element.querySelector("#prop-stroke-width") as HTMLInputElement | null;
    strokeSlider?.addEventListener("input", () => {
      const val = parseInt(strokeSlider.value, 10);
      editorState.updateToolSettings({ strokeWidth: val });
      const label = this.element.querySelector("#prop-stroke-val");
      if (label) label.textContent = `${val}px`;
    });

    // Opacity slider
    const opacitySlider = this.element.querySelector("#prop-opacity") as HTMLInputElement | null;
    opacitySlider?.addEventListener("input", () => {
      const val = parseFloat(opacitySlider.value);
      editorState.updateToolSettings({ opacity: val });
      const label = this.element.querySelector("#prop-opacity-val");
      if (label) label.textContent = `${Math.round(val * 100)}%`;
    });

    // Fill color transparent switch
    const fillTransparent = this.element.querySelector("#prop-fill-transparent") as HTMLInputElement | null;
    const fillPicker = this.element.querySelector("#prop-fill-color") as HTMLInputElement | null;
    fillTransparent?.addEventListener("change", () => {
      if (fillTransparent.checked) {
        editorState.updateToolSettings({ fillColor: null });
      } else if (fillPicker) {
        editorState.updateToolSettings({ fillColor: fillPicker.value });
      }
    });

    fillPicker?.addEventListener("input", () => {
      if (fillTransparent) fillTransparent.checked = false;
      editorState.updateToolSettings({ fillColor: fillPicker.value });
    });

    // Cover color
    const coverPicker = this.element.querySelector("#prop-cover-color") as HTMLInputElement | null;
    coverPicker?.addEventListener("input", () => {
      editorState.updateToolSettings({ coverColor: coverPicker.value });
    });

    // True Redact Keyword scrubber
    const redactKeywordBtn = this.element.querySelector("#btn-apply-text-redact");
    const redactKeywordInput = this.element.querySelector("#prop-redact-keyword") as HTMLInputElement | null;
    redactKeywordBtn?.addEventListener("click", async () => {
      const text = redactKeywordInput?.value.trim();
      if (!text) {
        toast.show({ message: "Please enter a phrase to scrub.", type: "warning" });
        return;
      }
      try {
        const dummyRect = { x: 0, y: 0, width: 612, height: 792 };
        const updated = await Backend.trueRedact(editorState.currentPage, dummyRect, text);
        editorState.setDocument(updated);
        toast.show({ message: `Scrubbed occurrences of '${text}' from Page ${editorState.currentPage + 1}.`, type: "success" });
      } catch (err: any) {
        toast.show({ message: `Redaction failed: ${err}`, type: "error" });
      }
    });

    // Crop Panel Handlers
    const ratioSelect = this.element.querySelector("#prop-crop-ratio") as HTMLSelectElement | null;
    ratioSelect?.addEventListener("change", () => {
      const mode = ratioSelect.value as any;
      editorState.setCropRatioMode(mode);

      // Re-conform active crop box to selected ratio if not free
      if (mode !== "free" && editorState.cropBox && editorState.doc) {
        const page = editorState.doc.pages[editorState.currentPage];
        let targetRatio = 1.0;
        if (mode === "1:1") targetRatio = 1.0;
        else if (mode === "4:3") targetRatio = 4 / 3;
        else if (mode === "16:9") targetRatio = 16 / 9;
        else if (mode === "original") targetRatio = page.width / page.height;

        const cur = editorState.cropBox;
        let newW = cur.width;
        let newH = newW / targetRatio;
        if (cur.y + newH > page.height) {
          newH = page.height - cur.y;
          newW = newH * targetRatio;
        }
        editorState.setCropBox({ ...cur, width: newW, height: newH });
      }
    });

    const cropWInput = this.element.querySelector("#prop-crop-w") as HTMLInputElement | null;
    const cropHInput = this.element.querySelector("#prop-crop-h") as HTMLInputElement | null;
    const cropXInput = this.element.querySelector("#prop-crop-x") as HTMLInputElement | null;
    const cropYInput = this.element.querySelector("#prop-crop-y") as HTMLInputElement | null;

    if (cropWInput && cropHInput && cropXInput && cropYInput) {
      const fields = [cropXInput, cropYInput, cropWInput, cropHInput];
      const commit = () => {
        const [x, y, width, height] = fields.map((field) => field.valueAsNumber);
        if ([x, y, width, height].every(Number.isFinite)) {
          this.committingCropFields = true;
          try {
            editorState.setCropBox({ x, y, width, height });
          } finally {
            this.committingCropFields = false;
          }
        }
        const box = editorState.cropBox;
        if (box) {
          [box.x, box.y, box.width, box.height].forEach((value, index) => {
            fields[index].value = String(Math.round(value));
          });
        }
      };
      for (const field of fields) {
        field.addEventListener("change", commit);
        field.addEventListener("keydown", (event) => {
          if (event.key === "Enter") { event.preventDefault(); commit(); }
        });
      }
    }

    for (const scope of this.element.querySelectorAll<HTMLInputElement>('input[name="crop-scope"]')) {
      scope.addEventListener("change", () => { this.cropScope = scope.value; });
    }

    // Presets
    this.element.querySelector("#preset-trim-margins")?.addEventListener("click", () => {
      if (!editorState.doc) return;
      const page = editorState.doc.pages[editorState.currentPage];
      editorState.setCropBox({
        x: Math.round(page.width * 0.05),
        y: Math.round(page.height * 0.05),
        width: Math.round(page.width * 0.9),
        height: Math.round(page.height * 0.9),
      });
    });

    this.element.querySelector("#preset-fit-a4")?.addEventListener("click", () => {
      if (!editorState.doc) return;
      const page = editorState.doc.pages[editorState.currentPage];
      const a4Ratio = 210 / 297;
      let w = page.width * 0.9;
      let h = w / a4Ratio;
      if (h > page.height * 0.9) {
        h = page.height * 0.9;
        w = h * a4Ratio;
      }
      editorState.setCropBox({
        x: Math.round((page.width - w) / 2),
        y: Math.round((page.height - h) / 2),
        width: Math.round(w),
        height: Math.round(h),
      });
    });

    this.element.querySelector("#preset-fit-letter")?.addEventListener("click", () => {
      if (!editorState.doc) return;
      const page = editorState.doc.pages[editorState.currentPage];
      const letterRatio = 8.5 / 11;
      let w = page.width * 0.9;
      let h = w / letterRatio;
      if (h > page.height * 0.9) {
        h = page.height * 0.9;
        w = h * letterRatio;
      }
      editorState.setCropBox({
        x: Math.round((page.width - w) / 2),
        y: Math.round((page.height - h) / 2),
        width: Math.round(w),
        height: Math.round(h),
      });
    });

    this.element.querySelector("#preset-full-page")?.addEventListener("click", () => {
      if (!editorState.doc) return;
      const page = editorState.doc.pages[editorState.currentPage];
      editorState.setCropBox({
        x: 0,
        y: 0,
        width: page.width,
        height: page.height,
      });
    });

    // Apply & Cancel buttons in properties panel
    this.element.querySelector("#btn-panel-crop-apply")?.addEventListener("click", async () => {
      if (!editorState.cropBox || !editorState.doc) return;
      const scopeRadio = this.element.querySelector("input[name='crop-scope']:checked") as HTMLInputElement | null;
      const scope = scopeRadio?.value || "current";

      let targetPages: number[] = [editorState.currentPage];
      if (scope === "selected") {
        targetPages = editorState.selectedPages.size > 0 ? Array.from(editorState.selectedPages) : [editorState.currentPage];
      } else if (scope === "all") {
        targetPages = Array.from({ length: editorState.doc.page_count }, (_, i) => i);
      }

      try {
        const page = editorState.currentPage;
        const updated = await Backend.cropPages(targetPages, editorState.cropBox);
        editorState.setDocument(updated);
        editorState.setTool("select");
        editorState.setCurrentPage(page);
        toast.show({
          message: `Crop applied to ${targetPages.length} page(s).`,
          type: "success",
        });
      } catch (err: any) {
        toast.show({ message: err.toString(), type: "error" });
      }
    });

    this.element.querySelector("#btn-panel-crop-cancel")?.addEventListener("click", () => {
      editorState.setCropBox(null);
      editorState.setTool("select");
    });
  }
}
