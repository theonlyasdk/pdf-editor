/// <reference types="vite/client" />
import { FilePlus2, X } from "lucide";
import { Backend } from "../ipc/backend";
import { editorState } from "../state/editorState";
import { toast } from "./Toast";
import { icon } from "./ui/icon";
import "../styles/doc-tools.css";

export type InsertPosition = "after-current" | "before-current" | "start" | "end";
export type PageSizePreset = "match" | "a4" | "letter" | "legal" | "custom";
export type PageOrientation = "portrait" | "landscape";
export type MeasurementUnit = "pt" | "mm" | "in";

const PT_PER_INCH = 72;
const MM_PER_INCH = 25.4;

export const PAGE_PRESET_POINTS: Record<Exclude<PageSizePreset, "match" | "custom">, { width: number; height: number }> = {
  a4: { width: 595.28, height: 841.89 },
  letter: { width: 612, height: 792 },
  legal: { width: 612, height: 1008 },
};

export function pointsToUnit(pt: number, unit: MeasurementUnit): number {
  if (unit === "in") return pt / PT_PER_INCH;
  if (unit === "mm") return (pt / PT_PER_INCH) * MM_PER_INCH;
  return pt;
}

export function unitToPoints(value: number, unit: MeasurementUnit): number {
  if (unit === "in") return value * PT_PER_INCH;
  if (unit === "mm") return (value / MM_PER_INCH) * PT_PER_INCH;
  return value;
}

export function applyOrientation(width: number, height: number, orientation: PageOrientation): { width: number; height: number } {
  const shortSide = Math.min(width, height);
  const longSide = Math.max(width, height);
  return orientation === "landscape"
    ? { width: longSide, height: shortSide }
    : { width: shortSide, height: longSide };
}

export function resolveInsertIndex(position: InsertPosition, currentPage: number, totalPages: number): number {
  switch (position) {
    case "start":
      return 0;
    case "before-current":
      return Math.max(0, Math.min(totalPages, currentPage));
    case "after-current":
      return Math.max(0, Math.min(totalPages, currentPage + 1));
    case "end":
      return Math.max(0, totalPages);
  }
}

export class InsertPageModalView {
  private dialog: HTMLDialogElement;
  private form: HTMLFormElement;
  private positionSelect: HTMLSelectElement;
  private presetSelect: HTMLSelectElement;
  private portraitBtn: HTMLButtonElement;
  private landscapeBtn: HTMLButtonElement;
  private customFieldsWrap: HTMLElement;
  private widthInput: HTMLInputElement;
  private heightInput: HTMLInputElement;
  private widthUnitEl: HTMLElement;
  private heightUnitEl: HTMLElement;
  private previewDimsEl: HTMLElement;
  private errorEl: HTMLElement;
  private submitBtn: HTMLButtonElement;
  private orientation: PageOrientation = "portrait";
  private focusReturn: HTMLElement | null = null;
  private busy = false;
  private docVersion = editorState.documentVersion;

  constructor() {
    this.dialog = document.createElement("dialog");
    this.dialog.className = "doc-modal";
    this.dialog.setAttribute("aria-labelledby", "insert-page-modal-title");
    this.dialog.innerHTML = `
      <div class="doc-modal-header">
        <div class="doc-modal-title-wrap">
          ${icon(FilePlus2)}
          <h2 id="insert-page-modal-title">Insert blank page</h2>
        </div>
        <button type="button" class="ui-button ui-button--tool" data-close aria-label="Close insert page dialog">
          ${icon(X)}
        </button>
      </div>
      <form id="insert-page-form" class="doc-modal-body">
        <div class="doc-field">
          <label class="doc-label" for="insert-position">Insertion position</label>
          <select class="ui-input" id="insert-position">
            <option value="after-current">After current page</option>
            <option value="before-current">Before current page</option>
            <option value="start">At start of document</option>
            <option value="end">At end of document</option>
          </select>
        </div>

        <div class="doc-form-grid">
          <div class="doc-field">
            <label class="doc-label" for="insert-preset">Page size</label>
            <select class="ui-input" id="insert-preset">
              <option value="match">Match current page</option>
              <option value="a4">A4 (210 × 297 mm)</option>
              <option value="letter">US Letter (8.5 × 11 in)</option>
              <option value="legal">Legal (8.5 × 14 in)</option>
              <option value="custom">Custom size</option>
            </select>
          </div>
          <div class="doc-field">
            <span class="doc-label">Orientation</span>
            <div class="doc-segmented" role="group" aria-label="Page orientation">
              <button type="button" class="doc-segmented-btn" id="insert-orient-portrait" aria-pressed="true">Portrait</button>
              <button type="button" class="doc-segmented-btn" id="insert-orient-landscape" aria-pressed="false">Landscape</button>
            </div>
          </div>
        </div>

        <div class="doc-form-grid" id="insert-custom-dims" hidden>
          <div class="doc-field">
            <label class="doc-label" for="insert-custom-width">
              <span>Width</span>
              <span id="insert-width-unit">pt</span>
            </label>
            <input class="ui-input doc-tabular" id="insert-custom-width" type="number" step="any" min="1" value="612" />
          </div>
          <div class="doc-field">
            <label class="doc-label" for="insert-custom-height">
              <span>Height</span>
              <span id="insert-height-unit">pt</span>
            </label>
            <input class="ui-input doc-tabular" id="insert-custom-height" type="number" step="any" min="1" value="792" />
          </div>
        </div>

        <div class="doc-preview-box">
          <span class="doc-hint">Output dimensions</span>
          <span class="doc-tabular font-semibold" id="insert-dims-preview">612 × 792 pt</span>
        </div>

        <p class="doc-error" id="insert-page-error" role="alert" hidden></p>
      </form>
      <div class="doc-modal-footer">
        <div class="doc-modal-footer-actions">
          <button type="button" class="ui-button ui-button--outline" data-close>Cancel</button>
          <button type="submit" form="insert-page-form" class="ui-button ui-button--default" id="insert-page-submit">Insert page</button>
        </div>
      </div>
    `;

    document.body.appendChild(this.dialog);

    this.form = this.dialog.querySelector("#insert-page-form")!;
    this.positionSelect = this.dialog.querySelector("#insert-position")!;
    this.presetSelect = this.dialog.querySelector("#insert-preset")!;
    this.portraitBtn = this.dialog.querySelector("#insert-orient-portrait")!;
    this.landscapeBtn = this.dialog.querySelector("#insert-orient-landscape")!;
    this.customFieldsWrap = this.dialog.querySelector("#insert-custom-dims")!;
    this.widthInput = this.dialog.querySelector("#insert-custom-width")!;
    this.heightInput = this.dialog.querySelector("#insert-custom-height")!;
    this.widthUnitEl = this.dialog.querySelector("#insert-width-unit")!;
    this.heightUnitEl = this.dialog.querySelector("#insert-height-unit")!;
    this.previewDimsEl = this.dialog.querySelector("#insert-dims-preview")!;
    this.errorEl = this.dialog.querySelector("#insert-page-error")!;
    this.submitBtn = this.dialog.querySelector("#insert-page-submit")!;

    this.bindEvents();
  }

  private bindEvents() {
    window.addEventListener("open-insert-page", () => this.open());

    this.dialog.addEventListener("click", (e) => {
      if (e.target === this.dialog && !this.busy) this.close();
    });

    this.dialog.addEventListener("close", () => {
      if (this.focusReturn?.isConnected) {
        this.focusReturn.focus({ preventScroll: true });
      }
      this.focusReturn = null;
    });

    this.dialog.querySelectorAll("[data-close]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (!this.busy) this.close();
      });
    });

    this.presetSelect.addEventListener("change", () => this.handlePresetChange());
    this.portraitBtn.addEventListener("click", () => this.setOrientation("portrait"));
    this.landscapeBtn.addEventListener("click", () => this.setOrientation("landscape"));
    this.widthInput.addEventListener("input", () => this.updatePreview());
    this.heightInput.addEventListener("input", () => this.updatePreview());

    this.form.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.handleSubmit();
    });

    editorState.subscribe(() => {
      if (this.docVersion !== editorState.documentVersion) {
        this.docVersion = editorState.documentVersion;
        if (this.dialog.open) this.close();
      }
    });
  }

  open() {
    if (!editorState.doc || editorState.openingFile) {
      toast.show({ message: "Open a PDF document first.", type: "warning" });
      return;
    }
    this.focusReturn = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.populateOptions();
    if (!this.dialog.open) this.dialog.showModal();
    this.positionSelect.focus();
  }

  close() {
    if (this.dialog.open) this.dialog.close();
  }

  private populateOptions() {
    const doc = editorState.doc;
    if (!doc) return;
    const cur = editorState.currentPage + 1;
    const total = doc.page_count;

    const afterOpt = this.positionSelect.querySelector<HTMLOptionElement>('option[value="after-current"]')!;
    const beforeOpt = this.positionSelect.querySelector<HTMLOptionElement>('option[value="before-current"]')!;
    const startOpt = this.positionSelect.querySelector<HTMLOptionElement>('option[value="start"]')!;
    const endOpt = this.positionSelect.querySelector<HTMLOptionElement>('option[value="end"]')!;
    afterOpt.textContent = `After current page (Page ${cur})`;
    beforeOpt.textContent = `Before current page (Page ${cur})`;
    startOpt.textContent = "At start of document (before Page 1)";
    endOpt.textContent = `At end of document (after Page ${total})`;

    const page = doc.pages[editorState.currentPage] ?? { width: 612, height: 792 };
    this.orientation = page.width > page.height ? "landscape" : "portrait";
    this.syncOrientationButtons();

    this.presetSelect.value = "match";
    this.customFieldsWrap.hidden = true;
    this.syncCustomInputsFromPoints(page.width, page.height);
    this.setError(null);
    this.updatePreview();
  }

  private handlePresetChange() {
    const preset = this.presetSelect.value as PageSizePreset;
    const isCustom = preset === "custom";
    this.customFieldsWrap.hidden = !isCustom;
    if (preset === "match") {
      const page = editorState.doc?.pages[editorState.currentPage];
      if (page) {
        this.orientation = page.width > page.height ? "landscape" : "portrait";
        this.syncOrientationButtons();
      }
    } else if (isCustom) {
      const dims = this.getTargetPoints();
      this.syncCustomInputsFromPoints(dims.width, dims.height);
    }
    this.updatePreview();
  }

  private setOrientation(orientation: PageOrientation) {
    this.orientation = orientation;
    this.syncOrientationButtons();
    if (this.presetSelect.value === "custom") {
      const w = parseFloat(this.widthInput.value);
      const h = parseFloat(this.heightInput.value);
      if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
        const oriented = applyOrientation(w, h, orientation);
        this.widthInput.value = String(Number(oriented.width.toFixed(2)));
        this.heightInput.value = String(Number(oriented.height.toFixed(2)));
      }
    }
    this.updatePreview();
  }

  private syncOrientationButtons() {
    this.portraitBtn.setAttribute("aria-pressed", String(this.orientation === "portrait"));
    this.landscapeBtn.setAttribute("aria-pressed", String(this.orientation === "landscape"));
  }

  private syncCustomInputsFromPoints(widthPt: number, heightPt: number) {
    const unit = editorState.toolSettings.units;
    this.widthUnitEl.textContent = unit;
    this.heightUnitEl.textContent = unit;
    const decimals = unit === "pt" ? 0 : unit === "mm" ? 1 : 2;
    this.widthInput.value = pointsToUnit(widthPt, unit).toFixed(decimals);
    this.heightInput.value = pointsToUnit(heightPt, unit).toFixed(decimals);
  }

  private getTargetPoints(): { width: number; height: number } {
    const preset = this.presetSelect.value as PageSizePreset;
    if (preset === "custom") {
      const unit = editorState.toolSettings.units;
      const rawW = parseFloat(this.widthInput.value);
      const rawH = parseFloat(this.heightInput.value);
      return {
        width: unitToPoints(rawW, unit),
        height: unitToPoints(rawH, unit),
      };
    }

    let base: { width: number; height: number };
    if (preset === "match") {
      const page = editorState.doc?.pages[editorState.currentPage];
      base = page ? { width: page.width, height: page.height } : { width: 612, height: 792 };
    } else {
      base = PAGE_PRESET_POINTS[preset];
    }
    return applyOrientation(base.width, base.height, this.orientation);
  }

  private updatePreview() {
    const { width, height } = this.getTargetPoints();
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      this.previewDimsEl.textContent = "Invalid dimensions";
      return;
    }
    const unit = editorState.toolSettings.units;
    const ptText = `${Math.round(width)} × ${Math.round(height)} pt`;
    if (unit === "pt") {
      this.previewDimsEl.textContent = ptText;
    } else {
      const decimals = unit === "mm" ? 1 : 2;
      const uW = pointsToUnit(width, unit).toFixed(decimals);
      const uH = pointsToUnit(height, unit).toFixed(decimals);
      this.previewDimsEl.textContent = `${uW} × ${uH} ${unit} (${ptText})`;
    }
    this.setError(null);
  }

  private setError(message: string | null) {
    this.errorEl.hidden = !message;
    this.errorEl.textContent = message ?? "";
  }

  private async handleSubmit() {
    if (this.busy || !editorState.doc) return;
    const { width, height } = this.getTargetPoints();
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 36 || height < 36 || width > 14400 || height > 14400) {
      this.setError("Enter valid page dimensions between 36 pt (0.5 in) and 14,400 pt (200 in).");
      return;
    }

    const position = this.positionSelect.value as InsertPosition;
    const atIndex = resolveInsertIndex(position, editorState.currentPage, editorState.doc.page_count);

    this.busy = true;
    this.submitBtn.disabled = true;
    this.submitBtn.textContent = "Inserting...";
    try {
      const updated = await Backend.insertBlankPage(atIndex, width, height);
      editorState.updateDocument(updated);
      editorState.setCurrentPage(atIndex);
      toast.show({ message: `Inserted blank page at Page ${atIndex + 1}.`, type: "success" });
      this.close();
    } catch (err) {
      this.setError(String(err));
      toast.show({ message: `Could not insert blank page: ${String(err)}`, type: "error" });
    } finally {
      this.busy = false;
      this.submitBtn.disabled = false;
      this.submitBtn.textContent = "Insert page";
    }
  }
}

let insertPageModalInstance: InsertPageModalView | null = null;

export function initInsertPageModal(): InsertPageModalView {
  if (!insertPageModalInstance) {
    insertPageModalInstance = new InsertPageModalView();
  }
  return insertPageModalInstance;
}

if (typeof document !== "undefined") {
  initInsertPageModal();
}

