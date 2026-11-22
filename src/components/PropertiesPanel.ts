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

  constructor(element: HTMLElement) {
    this.element = element;
    this.element.className = "properties-panel";
    this.render();
    editorState.subscribe(() => this.render());
  }

  render() {
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
          <div class="d-flex align-items-center gap-2">
            <input type="color" class="form-control form-control-color" id="prop-stroke-color" value="${settings.strokeColor}" />
            <span class="font-monospace small">${settings.strokeColor}</span>
          </div>
          <div class="color-presets mt-1">
            ${RECENT_COLORS.map(
              (c) => `<div class="color-swatch ${c === settings.strokeColor ? "active" : ""}" style="background:${c}" data-color="${c}"></div>`
            ).join("")}
          </div>
        </div>

        <div class="property-group">
          <label class="property-label">${STRINGS.properties.strokeWidth}: <span id="prop-stroke-val">${settings.strokeWidth}px</span></label>
          <input type="range" class="form-range" id="prop-stroke-width" min="1" max="24" value="${settings.strokeWidth}" />
        </div>

        <div class="property-group">
          <label class="property-label">${STRINGS.properties.opacity}: <span id="prop-opacity-val">${Math.round(settings.opacity * 100)}%</span></label>
          <input type="range" class="form-range" id="prop-opacity" min="0.1" max="1" step="0.05" value="${settings.opacity}" />
        </div>
      `;
    } else if (tool === "rectangle" || tool === "circle" || tool === "line" || tool === "arrow") {
      bodyHtml = `
        <div class="property-group">
          <label class="property-label">${STRINGS.properties.strokeColor}</label>
          <input type="color" class="form-control form-control-color" id="prop-stroke-color" value="${settings.strokeColor}" />
          <div class="color-presets mt-1">
            ${RECENT_COLORS.map(
              (c) => `<div class="color-swatch ${c === settings.strokeColor ? "active" : ""}" style="background:${c}" data-color="${c}"></div>`
            ).join("")}
          </div>
        </div>

        <div class="property-group">
          <label class="property-label">${STRINGS.properties.fillColor}</label>
          <div class="d-flex align-items-center gap-2">
            <input type="color" class="form-control form-control-color" id="prop-fill-color" value="${settings.fillColor || "#ffffff"}" />
            <div class="form-check form-switch mb-0">
              <input class="form-check-input" type="checkbox" id="prop-fill-transparent" ${!settings.fillColor ? "checked" : ""} />
              <label class="form-check-label small" for="prop-fill-transparent">Transparent</label>
            </div>
          </div>
        </div>

        <div class="property-group">
          <label class="property-label">${STRINGS.properties.strokeWidth}: <span id="prop-stroke-val">${settings.strokeWidth}px</span></label>
          <input type="range" class="form-range" id="prop-stroke-width" min="1" max="20" value="${settings.strokeWidth}" />
        </div>

        <div class="property-group">
          <label class="property-label">${STRINGS.properties.opacity}: <span id="prop-opacity-val">${Math.round(settings.opacity * 100)}%</span></label>
          <input type="range" class="form-range" id="prop-opacity" min="0.1" max="1" step="0.05" value="${settings.opacity}" />
        </div>
      `;
    } else if (tool === "freeText") {
      bodyHtml = `
        <div class="property-group">
          <label class="property-label">Text Color</label>
          <input type="color" class="form-control form-control-color" id="prop-stroke-color" value="${settings.strokeColor}" />
        </div>

        <div class="property-group">
          <label class="property-label">${STRINGS.properties.fontSize}: <span id="prop-font-size-val">${settings.fontSize}pt</span></label>
          <input type="range" class="form-range" id="prop-font-size" min="8" max="72" value="${settings.fontSize}" />
        </div>

        <div class="property-group">
          <label class="property-label">${STRINGS.properties.fontFamily}</label>
          <select class="form-select form-select-sm" id="prop-font-family">
            <option value="Helvetica, Arial, sans-serif">Helvetica / Sans-Serif</option>
            <option value="'Times New Roman', Times, serif">Times New Roman</option>
            <option value="'Courier New', Courier, monospace">Courier / Monospace</option>
          </select>
        </div>
      `;
    } else if (tool === "crop") {
      bodyHtml = `
        <div class="property-group">
          <label class="property-label">${STRINGS.crop.title}</label>
          <p class="small text-muted mb-2">Draw a crop box on any page or apply a standard preset below.</p>
          <div class="d-grid gap-2">
            <button class="btn btn-outline-secondary btn-sm text-start" id="crop-preset-trim">${STRINGS.crop.presetTrimMargins}</button>
            <button class="btn btn-outline-secondary btn-sm text-start" id="crop-preset-a4">${STRINGS.crop.presetA4}</button>
            <button class="btn btn-outline-secondary btn-sm text-start" id="crop-preset-letter">${STRINGS.crop.presetLetter}</button>
            <button class="btn btn-outline-danger btn-sm text-start mt-2" id="crop-reset">${STRINGS.crop.reset}</button>
          </div>
        </div>
      `;
    } else if (tool === "coverErase") {
      bodyHtml = `
        <div class="property-group">
          <label class="property-label">Cover Fill Color</label>
          <div class="d-flex align-items-center gap-2 mb-2">
            <input type="color" class="form-control form-control-color" id="prop-cover-color" value="${settings.coverColor}" />
            <span class="small text-muted">White by default</span>
          </div>
          <p class="small text-muted">Drag a rectangle on the page to cover unwanted content visually.</p>
        </div>
      `;
    } else if (tool === "trueRedact") {
      bodyHtml = `
        <div class="property-group">
          <div class="alert alert-danger py-2 px-3 small mb-2">
            <strong>${STRINGS.redaction.title}</strong>
            <p class="mb-0 mt-1" style="font-size: 11px;">${STRINGS.redaction.warning}</p>
          </div>
          <label class="property-label">${STRINGS.redaction.targetText}</label>
          <input type="text" class="form-control form-control-sm mb-2" id="prop-redact-keyword" placeholder="e.g. SECRET_SSN" />
          <button class="btn btn-danger btn-sm w-100" id="btn-apply-text-redact">
            Scrub Matching Text on Page
          </button>
          <p class="small text-muted mt-2" style="font-size: 11px;">
            Or drag a red bounding box directly over any content on the page to permanently excise it.
          </p>
        </div>
      `;
    } else if (tool === "stamp") {
      bodyHtml = `
        <div class="property-group">
          <label class="property-label">${STRINGS.properties.stampType}</label>
          <select class="form-select form-select-sm" id="prop-stamp-select">
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
        <div class="text-center text-muted my-5">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="mb-2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg>
          <p class="small px-3">${STRINGS.properties.noSelection}</p>
        </div>
      `;
    }

    this.element.innerHTML = `
      <div class="panel-header">
        <span class="small fw-bold">${STRINGS.properties.title}</span>
        <span class="badge bg-light text-dark border small text-capitalize">${tool}</span>
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

    // Crop Presets
    this.element.querySelector("#crop-preset-trim")?.addEventListener("click", async () => {
      if (!editorState.doc) return;
      const pageInfo = editorState.doc.pages[editorState.currentPage];
      const trimW = pageInfo.width * 0.9;
      const trimH = pageInfo.height * 0.9;
      const cropBox = {
        x: pageInfo.width * 0.05,
        y: pageInfo.height * 0.05,
        width: trimW,
        height: trimH,
      };
      try {
        const updated = await Backend.cropPages([editorState.currentPage], cropBox);
        editorState.setDocument(updated);
        toast.show({ message: "Applied 10% margin trim", type: "info" });
      } catch (err: any) {
        toast.show({ message: err.toString(), type: "error" });
      }
    });

    this.element.querySelector("#crop-reset")?.addEventListener("click", async () => {
      try {
        const updated = await Backend.cropPages([editorState.currentPage], null);
        editorState.setDocument(updated);
        toast.show({ message: "Reset page crop box", type: "info" });
      } catch (err: any) {
        toast.show({ message: err.toString(), type: "error" });
      }
    });
  }
}
