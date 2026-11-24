import { Copy, Lock, PenTool, Scissors, Trash2, Unlock, X } from "lucide";
import { STRINGS } from "../i18n/strings";
import { Backend } from "../ipc/backend";
import { editorState } from "../state/editorState";
import type { AnnotationDto, DocumentDto, PageBox } from "../types/editor";
import { formatMeasurement, formatUnitValue, unitStep, unitToPt } from "./cropGeometry";
import {
  duplicateAnnotationDto,
  normalizeHexColor,
  pdfFontNormalize,
  updateAnnotationRect,
  type AreaRedactItem,
} from "./drawing";
import { clearPendingPlacement, getPendingPlacement } from "./SignatureModal";
import { toast } from "./Toast";
import { icon } from "./ui/icon";

type ExtendedBackend = typeof Backend & {
  updateAnnotation(annotation: AnnotationDto): Promise<DocumentDto>;
  applyAreaRedactions(items: AreaRedactItem[]): Promise<DocumentDto>;
  detectCropMargins(pageIndex: number): Promise<PageBox>;
};

type ExtendedEditorState = typeof editorState & {
  pendingRedactions?: AreaRedactItem[];
  removePendingRedaction?(index: number): void;
  clearPendingRedactions?(): void;
};

const backend = Backend as ExtendedBackend;
const extState = editorState as ExtendedEditorState;

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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDateDisplay(iso?: string | null): string {
  if (!iso) return "—";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export class PropertiesPanelView {
  private element: HTMLElement;
  private committingCropFields = false;
  private cropScope = "current";

  constructor(element: HTMLElement) {
    this.element = element;
    this.element.className = "properties-panel";
    this.render();
    editorState.subscribe(() => this.render());
    window.addEventListener("pending-placement-changed", () => {
      if (editorState.activeTool === "stamp") this.render();
    });
  }

  private getSelectedAnnotation(): AnnotationDto | null {
    if (editorState.activeTool !== "select" || !editorState.selectedAnnotationId) return null;
    return editorState.doc?.annotations?.find(({ id }) => id === editorState.selectedAnnotationId) ?? null;
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
    const unit = settings.units;
    const selectedAnnot = this.getSelectedAnnotation();

    let headerBadge = tool === "select" ? "" : `<span class="ui-badge text-xs capitalize">${STRINGS.tools[tool as keyof typeof STRINGS.tools] ?? tool}</span>`;
    let bodyHtml = "";

    if (tool === "select" && selectedAnnot) {
      headerBadge = `<span class="ui-badge ui-badge--accent text-xs">${escapeHtml(selectedAnnot.annot_type)}</span>`;
      bodyHtml = this.renderSelectedAnnotationInspector(selectedAnnot);
    } else if (tool === "pen" || tool === "highlighter") {
      bodyHtml = `
        <div class="property-group">
          <label class="property-label">${STRINGS.properties.strokeColor}</label>
          <div class="flex items-center gap-2">
            <input type="color" class="ui-input ui-color" id="prop-stroke-color" value="${settings.strokeColor}" />
            <span class="tabular-nums text-xs">${settings.strokeColor}</span>
          </div>
          <div class="color-presets mt-1">
            ${RECENT_COLORS.map(
              (c) => `<div class="color-swatch ${c === settings.strokeColor ? "active" : ""}" style="background:${c}" data-color="${c}"></div>`,
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
              (c) => `<div class="color-swatch ${c === settings.strokeColor ? "active" : ""}" style="background:${c}" data-color="${c}"></div>`,
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
      const pending = extState.pendingRedactions ?? [];
      bodyHtml = `
        <div class="property-group">
          <div class="flex items-center justify-between">
            <label class="property-label mb-0">Area Redaction Queue</label>
            <span class="ui-badge tabular-nums" style="font-size:11px;">${pending.length} queued</span>
          </div>
          <p class="text-xs text-muted-foreground">Drag rectangles on any page to mark areas for permanent redaction.</p>
          ${
            pending.length === 0
              ? `<div class="rounded-md border border-border p-2 text-xs text-muted-foreground">No areas queued yet.</div>`
              : `<div class="flex flex-col gap-1 max-h-48 overflow-y-auto">
                  ${pending
                    .map(
                      (item, idx) => `
                        <div class="flex items-center justify-between gap-1 rounded-md border border-border px-2 py-1 text-xs">
                          <button type="button" class="text-left truncate flex-1 cursor-pointer" data-jump-redact="${item.page_index}" title="Jump to page ${item.page_index + 1}">
                            <span class="font-semibold text-destructive">#${idx + 1}</span>
                            <span class="tabular-nums">P.${item.page_index + 1} · ${formatMeasurement(item.rect.width, unit)} × ${formatMeasurement(item.rect.height, unit)}</span>
                          </button>
                          <button type="button" class="ui-button ui-button--tool" style="height:22px;min-width:22px;padding:0;" data-remove-redact="${idx}" aria-label="Remove redaction ${idx + 1}">
                            ${icon(X, 12)}
                          </button>
                        </div>
                      `,
                    )
                    .join("")}
                </div>
                <div class="grid gap-1.5 mt-1">
                  <button type="button" class="ui-button ui-button--destructive ui-button--sm" id="btn-apply-area-redactions">
                    Apply All Redactions (${pending.length})
                  </button>
                  <button type="button" class="ui-button ui-button--outline ui-button--sm" id="btn-clear-area-redactions">
                    Clear Queue
                  </button>
                </div>`
          }
        </div>

        <hr class="border-border" />

        <form class="property-group" id="redact-text-form">
          <label class="property-label" for="prop-redact-keyword">${STRINGS.redaction.targetText}</label>
          <input type="text" class="ui-input" id="prop-redact-keyword" placeholder="Enter a word or phrase" required />
          <button type="submit" class="ui-button ui-button--outline ui-button--sm text-destructive" id="btn-apply-text-redact">
            ${STRINGS.redaction.applyRedact}
          </button>
          <p class="text-xs text-muted-foreground">${STRINGS.redaction.warning}</p>
        </form>
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
      const step = unitStep(unit);

      bodyHtml = `
        <div class="property-group">
          <div class="flex justify-between items-center mb-1">
            <label class="property-label mb-0">Aspect Ratio</label>
            <span class="ui-badge ${ratioMode !== "free" ? "ui-badge--accent" : ""}" style="font-size: 10px;">
              ${ratioMode !== "free" ? "Ratio Locked" : "Hold Ctrl to Lock"}
            </span>
          </div>
          <select class="ui-input" id="prop-crop-ratio">
            <option value="free" ${ratioMode === "free" ? "selected" : ""}>Free crop</option>
            <option value="original" ${ratioMode === "original" ? "selected" : ""}>Fixed ? Original page ratio</option>
            <option value="1:1" ${ratioMode === "1:1" ? "selected" : ""}>Square (1:1)</option>
            <option value="4:3" ${ratioMode === "4:3" ? "selected" : ""}>Standard (4:3)</option>
            <option value="16:9" ${ratioMode === "16:9" ? "selected" : ""}>Widescreen (16:9)</option>
          </select>
          <div class="text-muted-foreground text-xs" style="font-size: 11px;">
            Fixed ratios scale the crop to fit the original page size. Hold <kbd>Ctrl</kbd> to lock the ratio while dragging in free mode.
          </div>
        </div>

        <div class="property-group">
          <label class="property-label">Crop Box Dimensions (${unit})</label>
          <div class="grid grid-cols-2 gap-2">
            <div class="min-w-0">
              <label class="text-xs text-muted-foreground" style="font-size: 11px;">Width (${unit})</label>
              <input type="number" class="ui-input tabular-nums" id="prop-crop-w" step="${step}" value="${formatUnitValue(box.width, unit)}" min="${formatUnitValue(20, unit)}" max="${formatUnitValue(page.width, unit)}" />
            </div>
            <div class="min-w-0">
              <label class="text-xs text-muted-foreground" style="font-size: 11px;">Height (${unit})</label>
              <input type="number" class="ui-input tabular-nums" id="prop-crop-h" step="${step}" value="${formatUnitValue(box.height, unit)}" min="${formatUnitValue(20, unit)}" max="${formatUnitValue(page.height, unit)}" />
            </div>
            <div class="min-w-0">
              <label class="text-xs text-muted-foreground" style="font-size: 11px;">Left / X (${unit})</label>
              <input type="number" class="ui-input tabular-nums" id="prop-crop-x" step="${step}" value="${formatUnitValue(box.x, unit)}" min="0" max="${formatUnitValue(page.width, unit)}" />
            </div>
            <div class="min-w-0">
              <label class="text-xs text-muted-foreground" style="font-size: 11px;">Top / Y (${unit})</label>
              <input type="number" class="ui-input tabular-nums" id="prop-crop-y" step="${step}" value="${formatUnitValue(box.y, unit)}" min="0" max="${formatUnitValue(page.height, unit)}" />
            </div>
          </div>
        </div>

        <div class="property-group">
          <label class="property-label">Quick Presets</label>
          <div class="grid gap-1">
            <button class="ui-button ui-button--outline ui-button--sm justify-start py-1" id="preset-auto-trim-margins">
              ${icon(Scissors, 13)}
              <span>Auto-Trim Margins</span>
            </button>
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
      const pendingPlacement = getPendingPlacement();
      const presets = ["APPROVED", "DRAFT", "CONFIDENTIAL", "FINAL", "REVISED"];
      const currentStamp = settings.stampText || "APPROVED";
      bodyHtml = `
        <div class="property-group">
          <label class="property-label">${STRINGS.properties.stampType}</label>
          <select class="ui-input" id="prop-stamp-select">
            ${presets.map((p) => `<option value="${p}" ${currentStamp === p ? "selected" : ""}>${p}</option>`).join("")}
            ${presets.includes(currentStamp) ? "" : `<option value="${escapeHtml(currentStamp)}" selected>${escapeHtml(currentStamp)}</option>`}
          </select>
        </div>
        <div class="property-group">
          <label class="property-label" for="prop-stamp-custom">Custom Text</label>
          <input type="text" class="ui-input" id="prop-stamp-custom" value="${escapeHtml(currentStamp)}" maxlength="40" />
        </div>
        <div class="property-group">
          <button type="button" class="ui-button ui-button--default ui-button--sm" id="btn-open-signature-modal">
            ${icon(PenTool, 14)}
            <span>Signature & Custom Stamp...</span>
          </button>
          ${
            pendingPlacement
              ? `<div class="ui-alert mt-1 flex flex-col gap-1.5 text-xs">
                  <span class="font-semibold">Click a page to place: ${escapeHtml(pendingPlacement.label)}</span>
                  <button type="button" class="ui-button ui-button--outline ui-button--sm" id="btn-cancel-placement">Cancel Placement</button>
                </div>`
              : `<p class="text-xs text-muted-foreground">Click on any page to place the active text stamp, or open the Signature & Stamp modal for drawings, images, and dated stamps.</p>`
          }
        </div>
      `;
    } else {
      bodyHtml = `
        <p class="properties-empty">${STRINGS.properties.noSelection}</p>
      `;
    }

    this.element.innerHTML = `
      <div class="panel-header">
        <span class="text-xs font-semibold">${STRINGS.properties.title}</span>
        ${headerBadge}
      </div>
      <div class="panel-body">
        ${bodyHtml}
      </div>
    `;

    this.bindPanelEvents();
  }

  private renderSelectedAnnotationInspector(annot: AnnotationDto): string {
    const unit = editorState.toolSettings.units;
    const step = unitStep(unit);
    const locked = annot.locked;
    const dis = locked ? "disabled" : "";
    const mainColor = normalizeHexColor(annot.color, "#2563eb");
    const fillColor = normalizeHexColor(annot.fill_color, "#ffffff");
    const hasFontControls =
      annot.annot_type === "FreeText" ||
      annot.annot_type === "Stamp" ||
      annot.font_size != null ||
      annot.font_family != null;
    const fontFamily = pdfFontNormalize(annot.font_family);
    const showText = annot.annot_type !== "Image";

    return `
      <div class="property-group">
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs text-muted-foreground tabular-nums">Page ${annot.page_index + 1}</span>
          <label class="ui-check text-xs cursor-pointer">
            <input type="checkbox" id="annot-prop-locked" ${locked ? "checked" : ""} />
            ${icon(locked ? Lock : Unlock, 13)}
            <span>${locked ? "Locked" : "Unlocked"}</span>
          </label>
        </div>
      </div>

      <div class="property-group">
        <label class="property-label">${STRINGS.properties.strokeColor}</label>
        <div class="flex items-center gap-2">
          <input type="color" class="ui-input ui-color" id="annot-prop-color" value="${mainColor}" ${dis} />
          <span class="tabular-nums text-xs">${mainColor}</span>
        </div>
        <div class="color-presets mt-1">
          ${RECENT_COLORS.map(
            (c) =>
              `<button type="button" class="color-swatch ${c === mainColor ? "active" : ""}" style="background:${c}" data-annot-color="${c}" ${dis} aria-label="Color ${c}"></button>`,
          ).join("")}
        </div>
      </div>

      <div class="property-group">
        <label class="property-label">${STRINGS.properties.fillColor}</label>
        <div class="flex items-center gap-2">
          <input type="color" class="ui-input ui-color" id="annot-prop-fill-color" value="${fillColor}" ${dis} />
          <div class="ui-check mb-0">
            <input type="checkbox" id="annot-prop-fill-transparent" ${!annot.fill_color ? "checked" : ""} ${dis} />
            <label class="text-xs" for="annot-prop-fill-transparent">Transparent</label>
          </div>
        </div>
      </div>

      <div class="property-group">
        <label class="property-label">${STRINGS.properties.strokeWidth}: <span class="tabular-nums" id="annot-prop-stroke-val">${annot.stroke_width}px</span></label>
        <input type="range" class="ui-slider" id="annot-prop-stroke-width" min="0" max="24" step="1" value="${annot.stroke_width}" ${dis} />
      </div>

      <div class="property-group">
        <label class="property-label">${STRINGS.properties.opacity}: <span class="tabular-nums" id="annot-prop-opacity-val">${Math.round(annot.opacity * 100)}%</span></label>
        <input type="range" class="ui-slider" id="annot-prop-opacity" min="0.05" max="1" step="0.05" value="${annot.opacity}" ${dis} />
      </div>

      ${
        showText
          ? `<div class="property-group">
              <label class="property-label" for="annot-prop-text">Text / Note</label>
              <textarea class="ui-input" style="height:auto;min-height:60px;padding:6px 8px;" id="annot-prop-text" rows="3" placeholder="Add note or text..." ${dis}>${escapeHtml(annot.text ?? "")}</textarea>
            </div>`
          : ""
      }

      ${
        hasFontControls
          ? `<div class="property-group">
              <label class="property-label">${STRINGS.properties.fontSize}: <span class="tabular-nums" id="annot-prop-font-size-val">${annot.font_size ?? 14}pt</span></label>
              <input type="range" class="ui-slider" id="annot-prop-font-size" min="8" max="72" value="${annot.font_size ?? 14}" ${dis} />
            </div>
            <div class="property-group">
              <label class="property-label" for="annot-prop-font-family">${STRINGS.properties.fontFamily}</label>
              <select class="ui-input" id="annot-prop-font-family" ${dis}>
                <option value="Helvetica" ${fontFamily === "Helvetica" ? "selected" : ""}>Helvetica / Sans-Serif</option>
                <option value="Times-Roman" ${fontFamily === "Times-Roman" ? "selected" : ""}>Times New Roman</option>
                <option value="Courier" ${fontFamily === "Courier" ? "selected" : ""}>Courier / Monospace</option>
              </select>
            </div>`
          : ""
      }

      <div class="property-group">
        <label class="property-label">Position & Size (${unit})</label>
        <div class="grid grid-cols-2 gap-2">
          <div class="min-w-0">
            <label class="text-xs text-muted-foreground" style="font-size:11px;">X (${unit})</label>
            <input type="number" class="ui-input tabular-nums" id="annot-prop-x" step="${step}" value="${formatUnitValue(annot.rect.x, unit)}" min="0" ${dis} />
          </div>
          <div class="min-w-0">
            <label class="text-xs text-muted-foreground" style="font-size:11px;">Y (${unit})</label>
            <input type="number" class="ui-input tabular-nums" id="annot-prop-y" step="${step}" value="${formatUnitValue(annot.rect.y, unit)}" min="0" ${dis} />
          </div>
          <div class="min-w-0">
            <label class="text-xs text-muted-foreground" style="font-size:11px;">W (${unit})</label>
            <input type="number" class="ui-input tabular-nums" id="annot-prop-w" step="${step}" value="${formatUnitValue(annot.rect.width, unit)}" min="${formatUnitValue(2, unit)}" ${dis} />
          </div>
          <div class="min-w-0">
            <label class="text-xs text-muted-foreground" style="font-size:11px;">H (${unit})</label>
            <input type="number" class="ui-input tabular-nums" id="annot-prop-h" step="${step}" value="${formatUnitValue(annot.rect.height, unit)}" min="${formatUnitValue(2, unit)}" ${dis} />
          </div>
        </div>
      </div>

      <div class="property-group">
        <label class="property-label" for="annot-prop-author">${STRINGS.properties.author}</label>
        <input type="text" class="ui-input" id="annot-prop-author" value="${escapeHtml(annot.author ?? "")}" placeholder="Author name" ${dis} />
        <span class="text-xs text-muted-foreground tabular-nums">Modified: ${escapeHtml(formatDateDisplay(annot.modified_date))}</span>
      </div>

      <div class="grid grid-cols-2 gap-2 mt-1">
        <button type="button" class="ui-button ui-button--outline ui-button--sm" id="btn-annot-duplicate">
          ${icon(Copy, 13)}
          <span>Duplicate</span>
        </button>
        <button type="button" class="ui-button ui-button--destructive ui-button--sm" id="btn-annot-delete" ${dis}>
          ${icon(Trash2, 13)}
          <span>Delete</span>
        </button>
      </div>
    `;
  }

  private async commitAnnotationPatch(annot: AnnotationDto, patch: Partial<AnnotationDto>) {
    const version = editorState.documentVersion;
    const next: AnnotationDto = {
      ...annot,
      ...patch,
      modified_date: new Date().toISOString(),
    };
    try {
      const updated = await backend.updateAnnotation(next);
      if (editorState.documentVersion === version) {
        editorState.updateDocument(updated);
      }
    } catch (error) {
      toast.show({ message: `Could not update annotation: ${String(error)}`, type: "error" });
    }
  }

  private bindPanelEvents() {
    this.bindInspectorEvents();

    // Stroke Color Picker
    const strokePicker = this.element.querySelector("#prop-stroke-color") as HTMLInputElement | null;
    strokePicker?.addEventListener("change", () => {
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
      editorState.updateToolSettings({ strokeWidth: val }, false);
      const label = this.element.querySelector("#prop-stroke-val");
      if (label) label.textContent = `${val}px`;
    });

    // Opacity slider
    const opacitySlider = this.element.querySelector("#prop-opacity") as HTMLInputElement | null;
    opacitySlider?.addEventListener("input", () => {
      const val = parseFloat(opacitySlider.value);
      editorState.updateToolSettings({ opacity: val }, false);
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

    fillPicker?.addEventListener("change", () => {
      if (fillTransparent) fillTransparent.checked = false;
      editorState.updateToolSettings({ fillColor: fillPicker.value });
    });

    // Cover color
    const coverPicker = this.element.querySelector("#prop-cover-color") as HTMLInputElement | null;
    coverPicker?.addEventListener("change", () => {
      editorState.updateToolSettings({ coverColor: coverPicker.value });
    });

    const textSize = this.element.querySelector<HTMLInputElement>("#prop-font-size");
    textSize?.addEventListener("input", () => {
      editorState.updateToolSettings({ fontSize: textSize.valueAsNumber }, false);
      const label = this.element.querySelector("#prop-font-size-val");
      if (label) label.textContent = `${textSize.value}pt`;
    });
    const font = this.element.querySelector<HTMLSelectElement>("#prop-font-family");
    if (font) {
      font.value = editorState.toolSettings.fontFamily;
      font.addEventListener("change", () => editorState.updateToolSettings({ fontFamily: font.value }));
    }

    // Stamp controls
    const stampSelect = this.element.querySelector<HTMLSelectElement>("#prop-stamp-select");
    stampSelect?.addEventListener("change", () => {
      editorState.updateToolSettings({ stampText: stampSelect.value });
    });
    const stampCustom = this.element.querySelector<HTMLInputElement>("#prop-stamp-custom");
    stampCustom?.addEventListener("change", () => {
      const val = stampCustom.value.trim();
      if (val) editorState.updateToolSettings({ stampText: val });
    });
    this.element.querySelector("#btn-open-signature-modal")?.addEventListener("click", () => {
      window.dispatchEvent(new Event("open-signature"));
    });
    this.element.querySelector("#btn-cancel-placement")?.addEventListener("click", () => {
      clearPendingPlacement();
    });

    // Area redaction queue handlers
    this.element.querySelectorAll<HTMLButtonElement>("[data-jump-redact]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const pageIndex = Number(btn.dataset.jumpRedact);
        editorState.setCurrentPage(pageIndex);
        window.dispatchEvent(new CustomEvent("jump-to-page", { detail: { pageIndex } }));
      });
    });
    this.element.querySelectorAll<HTMLButtonElement>("[data-remove-redact]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const index = Number(btn.dataset.removeRedact);
        extState.removePendingRedaction?.(index);
      });
    });
    this.element.querySelector("#btn-clear-area-redactions")?.addEventListener("click", () => {
      extState.clearPendingRedactions?.();
    });
    this.element.querySelector("#btn-apply-area-redactions")?.addEventListener("click", async () => {
      const items = [...(extState.pendingRedactions ?? [])];
      if (!items.length || !editorState.doc) return;
      const btn = this.element.querySelector<HTMLButtonElement>("#btn-apply-area-redactions");
      if (btn) btn.disabled = true;
      const version = editorState.documentVersion;
      try {
        const updated = await backend.applyAreaRedactions(items);
        if (editorState.documentVersion === version) {
          extState.clearPendingRedactions?.();
          editorState.updateDocument(updated);
        }
        toast.show({ message: `Applied ${items.length} area redaction(s).`, type: "success" });
      } catch (error) {
        if (btn) btn.disabled = false;
        toast.show({ message: String(error), type: "error" });
      }
    });

    const redactForm = this.element.querySelector<HTMLFormElement>("#redact-text-form");
    redactForm?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const field = redactForm.querySelector<HTMLInputElement>("#prop-redact-keyword")!;
      const text = field.value.trim();
      if (!text) return;
      const button = redactForm.querySelector("button")!;
      button.disabled = true;
      try {
        const updated = await Backend.redactText(editorState.currentPage, text);
        editorState.updateDocument(updated);
        toast.show({ message: "Text removed from the current page.", type: "success" });
      } catch (error) {
        button.disabled = false;
        toast.show({ message: String(error), type: "error" });
      }
    });

    // Crop Panel Handlers
    const ratioSelect = this.element.querySelector("#prop-crop-ratio") as HTMLSelectElement | null;
    ratioSelect?.addEventListener("change", () => {
      const mode = ratioSelect.value as any;
      editorState.setCropRatioMode(mode);

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
      const unit = editorState.toolSettings.units;
      const fields = [cropXInput, cropYInput, cropWInput, cropHInput];
      const commit = () => {
        const [x, y, width, height] = fields.map((field) => unitToPt(field.valueAsNumber, unit));
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
            fields[index].value = formatUnitValue(value, unit);
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
    const autoTrimBtn = this.element.querySelector<HTMLButtonElement>("#preset-auto-trim-margins");
    autoTrimBtn?.addEventListener("click", async () => {
      if (!editorState.doc) return;
      autoTrimBtn.disabled = true;
      const pageIndex = editorState.currentPage;
      const version = editorState.documentVersion;
      try {
        const detected = await backend.detectCropMargins(pageIndex);
        if (editorState.documentVersion !== version || editorState.activeTool !== "crop") return;
        if (editorState.toolSettings.cropRatioMode !== "free") {
          editorState.setCropRatioMode("free");
        }
        editorState.setCropBox(detected);
        toast.show({ message: "Crop box fitted to detected page content.", type: "success" });
      } catch (err) {
        toast.show({ message: `Auto-trim failed: ${String(err)}`, type: "error" });
      } finally {
        if (autoTrimBtn.isConnected) autoTrimBtn.disabled = false;
      }
    });

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
        const updated = await Backend.cropPages(targetPages, editorState.cropBox, editorState.toolSettings.cropRatioMode !== "free");
        editorState.updateDocument(updated);
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

  private bindInspectorEvents() {
    const annot = this.getSelectedAnnotation();
    if (!annot) return;

    const lockedCheck = this.element.querySelector<HTMLInputElement>("#annot-prop-locked");
    lockedCheck?.addEventListener("change", () => {
      void this.commitAnnotationPatch(annot, { locked: lockedCheck.checked });
    });

    const colorInput = this.element.querySelector<HTMLInputElement>("#annot-prop-color");
    colorInput?.addEventListener("change", () => {
      void this.commitAnnotationPatch(annot, { color: colorInput.value });
    });

    this.element.querySelectorAll<HTMLButtonElement>("[data-annot-color]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const color = btn.dataset.annotColor;
        if (color && !annot.locked) {
          void this.commitAnnotationPatch(annot, { color });
        }
      });
    });

    const fillPicker = this.element.querySelector<HTMLInputElement>("#annot-prop-fill-color");
    const fillTransparent = this.element.querySelector<HTMLInputElement>("#annot-prop-fill-transparent");
    fillTransparent?.addEventListener("change", () => {
      void this.commitAnnotationPatch(annot, {
        fill_color: fillTransparent.checked ? null : fillPicker?.value || "#ffffff",
      });
    });
    fillPicker?.addEventListener("change", () => {
      if (fillTransparent) fillTransparent.checked = false;
      void this.commitAnnotationPatch(annot, { fill_color: fillPicker.value });
    });

    const strokeSlider = this.element.querySelector<HTMLInputElement>("#annot-prop-stroke-width");
    strokeSlider?.addEventListener("input", () => {
      const label = this.element.querySelector("#annot-prop-stroke-val");
      if (label) label.textContent = `${strokeSlider.value}px`;
    });
    strokeSlider?.addEventListener("change", () => {
      void this.commitAnnotationPatch(annot, { stroke_width: strokeSlider.valueAsNumber });
    });

    const opacitySlider = this.element.querySelector<HTMLInputElement>("#annot-prop-opacity");
    opacitySlider?.addEventListener("input", () => {
      const label = this.element.querySelector("#annot-prop-opacity-val");
      if (label) label.textContent = `${Math.round(opacitySlider.valueAsNumber * 100)}%`;
    });
    opacitySlider?.addEventListener("change", () => {
      void this.commitAnnotationPatch(annot, { opacity: opacitySlider.valueAsNumber });
    });

    const textInput = this.element.querySelector<HTMLTextAreaElement>("#annot-prop-text");
    textInput?.addEventListener("change", () => {
      void this.commitAnnotationPatch(annot, { text: textInput.value });
    });

    const fontSizeSlider = this.element.querySelector<HTMLInputElement>("#annot-prop-font-size");
    fontSizeSlider?.addEventListener("input", () => {
      const label = this.element.querySelector("#annot-prop-font-size-val");
      if (label) label.textContent = `${fontSizeSlider.value}pt`;
    });
    fontSizeSlider?.addEventListener("change", () => {
      void this.commitAnnotationPatch(annot, { font_size: fontSizeSlider.valueAsNumber });
    });

    const fontFamilySelect = this.element.querySelector<HTMLSelectElement>("#annot-prop-font-family");
    fontFamilySelect?.addEventListener("change", () => {
      void this.commitAnnotationPatch(annot, { font_family: fontFamilySelect.value });
    });

    const authorInput = this.element.querySelector<HTMLInputElement>("#annot-prop-author");
    authorInput?.addEventListener("change", () => {
      void this.commitAnnotationPatch(annot, { author: authorInput.value.trim() || null });
    });

    const xInput = this.element.querySelector<HTMLInputElement>("#annot-prop-x");
    const yInput = this.element.querySelector<HTMLInputElement>("#annot-prop-y");
    const wInput = this.element.querySelector<HTMLInputElement>("#annot-prop-w");
    const hInput = this.element.querySelector<HTMLInputElement>("#annot-prop-h");
    if (xInput && yInput && wInput && hInput) {
      const unit = editorState.toolSettings.units;
      const fields = [xInput, yInput, wInput, hInput];
      const commitRect = () => {
        const [x, y, width, height] = fields.map((f) => unitToPt(f.valueAsNumber, unit));
        if (![x, y, width, height].every(Number.isFinite)) return;
        const page = editorState.doc?.pages[annot.page_index];
        const nextAnnot = updateAnnotationRect(annot, { x, y, width, height }, page);
        void this.commitAnnotationPatch(annot, {
          rect: nextAnnot.rect,
          points: nextAnnot.points,
        });
      };
      for (const field of fields) {
        field.addEventListener("change", commitRect);
        field.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commitRect();
          }
        });
      }
    }

    this.element.querySelector("#btn-annot-duplicate")?.addEventListener("click", async () => {
      const page = editorState.doc?.pages[annot.page_index];
      const clone = duplicateAnnotationDto(annot, page, editorState.toolSettings.author);
      const version = editorState.documentVersion;
      try {
        const updated = await Backend.addAnnotation(clone);
        if (editorState.documentVersion === version) {
          editorState.updateDocument(updated);
          editorState.selectAnnotation(clone.id);
        }
        toast.show({ message: "Annotation duplicated.", type: "success" });
      } catch (err) {
        toast.show({ message: `Could not duplicate annotation: ${String(err)}`, type: "error" });
      }
    });

    this.element.querySelector("#btn-annot-delete")?.addEventListener("click", async () => {
      if (annot.locked) return;
      const version = editorState.documentVersion;
      try {
        const updated = await Backend.deleteAnnotation(annot.page_index, annot.id);
        if (editorState.documentVersion === version) {
          editorState.updateDocument(updated);
        }
        toast.show({ message: "Annotation deleted.", type: "success" });
      } catch (err) {
        toast.show({ message: `Could not delete annotation: ${String(err)}`, type: "error" });
      }
    });
  }
}
