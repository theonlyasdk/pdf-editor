/// <reference types="vite/client" />
import { Stamp, X } from "lucide";
import { Backend, BatchOverlayKind, BatchOverlayOptions, BatchOverlayPosition } from "../ipc/backend";
import { editorState } from "../state/editorState";
import { createRangePreviewer, PageScopeMode, resolvePageSelection } from "./MergeSplitModal";
import { toast } from "./Toast";
import { icon } from "./ui/icon";
import "../styles/doc-tools.css";

export function formatBatesPreview(prefix: string, start: number, digits: number): string {
  const safeStart = Number.isFinite(start) && start >= 0 ? Math.floor(start) : 1;
  const safeDigits = Number.isFinite(digits) ? Math.max(1, Math.min(12, Math.floor(digits))) : 6;
  return `${prefix}${String(safeStart).padStart(safeDigits, "0")}`;
}

export class WatermarkModalView {
  private dialog: HTMLDialogElement;
  private form: HTMLFormElement;
  private kindButtons: HTMLButtonElement[];
  private watermarkSection: HTMLElement;
  private pageNumbersSection: HTMLElement;
  private headerFooterSection: HTMLElement;
  private batesSection: HTMLElement;
  private positionField: HTMLElement;
  private positionSelect: HTMLSelectElement;
  private rotationField: HTMLElement;
  private marginField: HTMLElement;

  private wmTextInput: HTMLInputElement;
  private wmRotationInput: HTMLInputElement;
  private wmRotationVal: HTMLElement;

  private pnTemplateInput: HTMLInputElement;

  private hfHeaderLeft: HTMLInputElement;
  private hfHeaderCenter: HTMLInputElement;
  private hfHeaderRight: HTMLInputElement;
  private hfFooterLeft: HTMLInputElement;
  private hfFooterCenter: HTMLInputElement;
  private hfFooterRight: HTMLInputElement;

  private batesPrefixInput: HTMLInputElement;
  private batesStartInput: HTMLInputElement;
  private batesDigitsInput: HTMLInputElement;
  private batesPreviewEl: HTMLElement;

  private fontSizeInput: HTMLInputElement;
  private colorInput: HTMLInputElement;
  private opacityInput: HTMLInputElement;
  private opacityVal: HTMLElement;
  private marginInput: HTMLInputElement;

  private scopeSelect: HTMLSelectElement;
  private rangeWrap: HTMLElement;
  private rangeInput: HTMLInputElement;
  private rangeStatus: HTMLElement;
  private errorEl: HTMLElement;
  private submitBtn: HTMLButtonElement;

  private activeKind: BatchOverlayKind = "watermark";
  private rangePreviewer: ReturnType<typeof createRangePreviewer>;
  private focusReturn: HTMLElement | null = null;
  private busy = false;
  private docVersion = editorState.documentVersion;

  constructor() {
    this.dialog = document.createElement("dialog");
    this.dialog.className = "doc-modal doc-modal--wide";
    this.dialog.setAttribute("aria-labelledby", "wm-modal-title");
    this.dialog.innerHTML = `
      <div class="doc-modal-header">
        <div class="doc-modal-title-wrap">
          ${icon(Stamp)}
          <h2 id="wm-modal-title">Watermarks, headers &amp; numbering</h2>
        </div>
        <button type="button" class="ui-button ui-button--tool" data-close aria-label="Close watermark and numbering dialog">
          ${icon(X)}
        </button>
      </div>
      <form id="wm-form" class="doc-modal-body">
        <div class="doc-modal-tabs" role="tablist" aria-label="Overlay type">
          <button type="button" class="doc-modal-tab" role="tab" data-kind="watermark" aria-selected="true">Watermark</button>
          <button type="button" class="doc-modal-tab" role="tab" data-kind="page_numbers" aria-selected="false">Page numbers</button>
          <button type="button" class="doc-modal-tab" role="tab" data-kind="header_footer" aria-selected="false">Header &amp; footer</button>
          <button type="button" class="doc-modal-tab" role="tab" data-kind="bates" aria-selected="false">Bates</button>
        </div>

        <section id="wm-sec-watermark" class="flex flex-col gap-3">
          <div class="doc-field">
            <label class="doc-label" for="wm-text">Watermark text</label>
            <input class="ui-input" id="wm-text" type="text" value="CONFIDENTIAL" placeholder="Enter watermark text" />
          </div>
          <div class="flex flex-wrap gap-1.5">
            <button type="button" class="ui-button ui-button--outline ui-button--sm" data-wm-preset="CONFIDENTIAL">CONFIDENTIAL</button>
            <button type="button" class="ui-button ui-button--outline ui-button--sm" data-wm-preset="DRAFT">DRAFT</button>
            <button type="button" class="ui-button ui-button--outline ui-button--sm" data-wm-preset="COPY">COPY</button>
            <button type="button" class="ui-button ui-button--outline ui-button--sm" data-wm-preset="INTERNAL USE">INTERNAL USE</button>
          </div>
        </section>

        <section id="wm-sec-page-numbers" class="flex flex-col gap-3" hidden>
          <div class="doc-field">
            <label class="doc-label" for="wm-pn-template">
              <span>Format template</span>
              <span class="doc-hint">Tokens: {page}, {total}</span>
            </label>
            <input class="ui-input" id="wm-pn-template" type="text" value="Page {page} of {total}" placeholder="Page {page} of {total}" />
          </div>
          <div class="flex flex-wrap gap-1.5">
            <button type="button" class="ui-button ui-button--outline ui-button--sm" data-pn-preset="Page {page} of {total}">Page X of Y</button>
            <button type="button" class="ui-button ui-button--outline ui-button--sm" data-pn-preset="{page} / {total}">X / Y</button>
            <button type="button" class="ui-button ui-button--outline ui-button--sm" data-pn-preset="Page {page}">Page X</button>
            <button type="button" class="ui-button ui-button--outline ui-button--sm" data-pn-preset="{page}">X</button>
          </div>
        </section>

        <section id="wm-sec-header-footer" class="flex flex-col gap-3" hidden>
          <p class="doc-hint">Supports tokens {page} and {total} in any header or footer slot.</p>
          <div class="doc-form-grid doc-form-grid--3">
            <div class="doc-field">
              <label class="doc-label" for="wm-hf-hl">Header left</label>
              <input class="ui-input" id="wm-hf-hl" type="text" placeholder="Optional" />
            </div>
            <div class="doc-field">
              <label class="doc-label" for="wm-hf-hc">Header center</label>
              <input class="ui-input" id="wm-hf-hc" type="text" placeholder="Optional" />
            </div>
            <div class="doc-field">
              <label class="doc-label" for="wm-hf-hr">Header right</label>
              <input class="ui-input" id="wm-hf-hr" type="text" placeholder="Optional" />
            </div>
            <div class="doc-field">
              <label class="doc-label" for="wm-hf-fl">Footer left</label>
              <input class="ui-input" id="wm-hf-fl" type="text" placeholder="Optional" />
            </div>
            <div class="doc-field">
              <label class="doc-label" for="wm-hf-fc">Footer center</label>
              <input class="ui-input" id="wm-hf-fc" type="text" placeholder="Page {page} of {total}" />
            </div>
            <div class="doc-field">
              <label class="doc-label" for="wm-hf-fr">Footer right</label>
              <input class="ui-input" id="wm-hf-fr" type="text" placeholder="Optional" />
            </div>
          </div>
        </section>

        <section id="wm-sec-bates" class="flex flex-col gap-3" hidden>
          <div class="doc-form-grid doc-form-grid--3">
            <div class="doc-field">
              <label class="doc-label" for="wm-bates-prefix">Prefix</label>
              <input class="ui-input" id="wm-bates-prefix" type="text" value="EXH-" placeholder="EXH-" />
            </div>
            <div class="doc-field">
              <label class="doc-label" for="wm-bates-start">Start number</label>
              <input class="ui-input doc-tabular" id="wm-bates-start" type="number" min="0" step="1" value="1" />
            </div>
            <div class="doc-field">
              <label class="doc-label" for="wm-bates-digits">Digits</label>
              <input class="ui-input doc-tabular" id="wm-bates-digits" type="number" min="1" max="12" step="1" value="6" />
            </div>
          </div>
          <div class="doc-preview-box">
            <span class="doc-hint">First page stamp</span>
            <span class="doc-tabular font-semibold" id="wm-bates-preview">EXH-000001</span>
          </div>
        </section>

        <div class="doc-form-grid">
          <div class="doc-field" id="wm-position-field">
            <label class="doc-label" for="wm-position">Position</label>
            <select class="ui-input" id="wm-position">
              <option value="center">Center</option>
              <option value="top_left">Top left</option>
              <option value="top_center">Top center</option>
              <option value="top_right">Top right</option>
              <option value="bottom_left">Bottom left</option>
              <option value="bottom_center">Bottom center</option>
              <option value="bottom_right">Bottom right</option>
            </select>
          </div>
          <div class="doc-field">
            <label class="doc-label" for="wm-font-size">Font size (pt)</label>
            <input class="ui-input doc-tabular" id="wm-font-size" type="number" min="6" max="180" step="1" value="48" />
          </div>
          <div class="doc-field">
            <label class="doc-label" for="wm-color">Color</label>
            <div class="flex items-center gap-2">
              <input class="ui-input ui-color" id="wm-color" type="color" value="#dc2626" />
              <span class="doc-hint doc-tabular" id="wm-color-label">#dc2626</span>
            </div>
          </div>
          <div class="doc-field">
            <label class="doc-label" for="wm-opacity">
              <span>Opacity</span>
              <span class="doc-tabular" id="wm-opacity-val">25%</span>
            </label>
            <input class="ui-slider" id="wm-opacity" type="range" min="0.05" max="1" step="0.05" value="0.25" />
          </div>
          <div class="doc-field" id="wm-rotation-field">
            <label class="doc-label" for="wm-rotation">
              <span>Rotation</span>
              <span class="doc-tabular" id="wm-rotation-val">45°</span>
            </label>
            <input class="ui-slider" id="wm-rotation" type="range" min="-90" max="90" step="5" value="45" />
          </div>
          <div class="doc-field" id="wm-margin-field" hidden>
            <label class="doc-label" for="wm-margin">Edge margin (pt)</label>
            <input class="ui-input doc-tabular" id="wm-margin" type="number" min="6" max="144" step="2" value="28" />
          </div>
        </div>

        <div class="doc-field">
          <label class="doc-label" for="wm-scope">Apply to pages</label>
          <select class="ui-input" id="wm-scope">
            <option value="all">All pages</option>
            <option value="current">Current page</option>
            <option value="selected">Selected pages</option>
            <option value="range">Custom page range</option>
          </select>
        </div>

        <div class="doc-field" id="wm-range-wrap" hidden>
          <label class="doc-label" for="wm-range">Page range expression</label>
          <input class="ui-input doc-tabular" id="wm-range" type="text" placeholder="e.g. 1-5, 8, odd, !3" autocomplete="off" />
          <p class="doc-hint doc-tabular" id="wm-range-status"></p>
        </div>

        <p class="doc-error" id="wm-error" role="alert" hidden></p>
      </form>
      <div class="doc-modal-footer">
        <div class="doc-modal-footer-actions">
          <button type="button" class="ui-button ui-button--outline" data-close>Cancel</button>
          <button type="submit" form="wm-form" class="ui-button ui-button--default" id="wm-submit">Apply to document</button>
        </div>
      </div>
    `;

    document.body.appendChild(this.dialog);

    this.form = this.dialog.querySelector("#wm-form")!;
    this.kindButtons = Array.from(this.dialog.querySelectorAll<HTMLButtonElement>("[data-kind]"));
    this.watermarkSection = this.dialog.querySelector("#wm-sec-watermark")!;
    this.pageNumbersSection = this.dialog.querySelector("#wm-sec-page-numbers")!;
    this.headerFooterSection = this.dialog.querySelector("#wm-sec-header-footer")!;
    this.batesSection = this.dialog.querySelector("#wm-sec-bates")!;
    this.positionField = this.dialog.querySelector("#wm-position-field")!;
    this.positionSelect = this.dialog.querySelector("#wm-position")!;
    this.rotationField = this.dialog.querySelector("#wm-rotation-field")!;
    this.marginField = this.dialog.querySelector("#wm-margin-field")!;

    this.wmTextInput = this.dialog.querySelector("#wm-text")!;
    this.wmRotationInput = this.dialog.querySelector("#wm-rotation")!;
    this.wmRotationVal = this.dialog.querySelector("#wm-rotation-val")!;

    this.pnTemplateInput = this.dialog.querySelector("#wm-pn-template")!;

    this.hfHeaderLeft = this.dialog.querySelector("#wm-hf-hl")!;
    this.hfHeaderCenter = this.dialog.querySelector("#wm-hf-hc")!;
    this.hfHeaderRight = this.dialog.querySelector("#wm-hf-hr")!;
    this.hfFooterLeft = this.dialog.querySelector("#wm-hf-fl")!;
    this.hfFooterCenter = this.dialog.querySelector("#wm-hf-fc")!;
    this.hfFooterRight = this.dialog.querySelector("#wm-hf-fr")!;

    this.batesPrefixInput = this.dialog.querySelector("#wm-bates-prefix")!;
    this.batesStartInput = this.dialog.querySelector("#wm-bates-start")!;
    this.batesDigitsInput = this.dialog.querySelector("#wm-bates-digits")!;
    this.batesPreviewEl = this.dialog.querySelector("#wm-bates-preview")!;

    this.fontSizeInput = this.dialog.querySelector("#wm-font-size")!;
    this.colorInput = this.dialog.querySelector("#wm-color")!;
    this.opacityInput = this.dialog.querySelector("#wm-opacity")!;
    this.opacityVal = this.dialog.querySelector("#wm-opacity-val")!;
    this.marginInput = this.dialog.querySelector("#wm-margin")!;

    this.scopeSelect = this.dialog.querySelector("#wm-scope")!;
    this.rangeWrap = this.dialog.querySelector("#wm-range-wrap")!;
    this.rangeInput = this.dialog.querySelector("#wm-range")!;
    this.rangeStatus = this.dialog.querySelector("#wm-range-status")!;
    this.errorEl = this.dialog.querySelector("#wm-error")!;
    this.submitBtn = this.dialog.querySelector("#wm-submit")!;
    this.rangePreviewer = createRangePreviewer(this.rangeStatus);

    this.bindEvents();
  }

  private bindEvents() {
    window.addEventListener("open-watermark", (event) => {
      const detail = (event as CustomEvent<{ kind?: BatchOverlayKind }>).detail;
      this.open(detail?.kind);
    });

    this.dialog.addEventListener("click", (e) => {
      if (e.target === this.dialog && !this.busy) this.close();
    });

    this.dialog.addEventListener("close", () => {
      this.rangePreviewer.cancel();
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

    for (const btn of this.kindButtons) {
      btn.addEventListener("click", () => {
        const kind = btn.dataset.kind as BatchOverlayKind;
        if (kind) this.switchKind(kind);
      });
    }

    this.dialog.querySelectorAll<HTMLButtonElement>("[data-wm-preset]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.wmTextInput.value = btn.dataset.wmPreset ?? "";
        this.setError(null);
      });
    });

    this.dialog.querySelectorAll<HTMLButtonElement>("[data-pn-preset]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.pnTemplateInput.value = btn.dataset.pnPreset ?? "";
        this.setError(null);
      });
    });

    this.wmRotationInput.addEventListener("input", () => {
      this.wmRotationVal.textContent = `${this.wmRotationInput.value}°`;
    });

    this.opacityInput.addEventListener("input", () => {
      this.opacityVal.textContent = `${Math.round(Number(this.opacityInput.value) * 100)}%`;
    });

    this.colorInput.addEventListener("input", () => {
      const label = this.dialog.querySelector("#wm-color-label");
      if (label) label.textContent = this.colorInput.value;
    });

    const updateBates = () => {
      this.batesPreviewEl.textContent = formatBatesPreview(
        this.batesPrefixInput.value,
        Number(this.batesStartInput.value),
        Number(this.batesDigitsInput.value)
      );
    };
    this.batesPrefixInput.addEventListener("input", updateBates);
    this.batesStartInput.addEventListener("input", updateBates);
    this.batesDigitsInput.addEventListener("input", updateBates);

    this.scopeSelect.addEventListener("change", () => {
      const isRange = this.scopeSelect.value === "range";
      this.rangeWrap.hidden = !isRange;
      this.setError(null);
      if (isRange) void this.rangePreviewer.evaluateNow(this.rangeInput.value);
    });

    this.rangeInput.addEventListener("input", () => {
      this.setError(null);
      this.rangePreviewer.schedule(this.rangeInput.value);
    });

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

  open(initialKind?: BatchOverlayKind) {
    if (!editorState.doc || editorState.openingFile) {
      toast.show({ message: "Open a PDF document first.", type: "warning" });
      return;
    }
    this.focusReturn = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.populateScope();
    this.switchKind(initialKind ?? "watermark");
    if (!this.dialog.open) this.dialog.showModal();
  }

  close() {
    if (this.dialog.open) this.dialog.close();
  }

  private populateScope() {
    const doc = editorState.doc;
    if (!doc) return;
    const cur = editorState.currentPage + 1;
    const total = doc.page_count;
    const selCount = editorState.selectedPages.size;

    const allOpt = this.scopeSelect.querySelector<HTMLOptionElement>('option[value="all"]')!;
    const curOpt = this.scopeSelect.querySelector<HTMLOptionElement>('option[value="current"]')!;
    const selOpt = this.scopeSelect.querySelector<HTMLOptionElement>('option[value="selected"]')!;
    allOpt.textContent = `All pages (1–${total})`;
    curOpt.textContent = `Current page (Page ${cur})`;
    selOpt.disabled = selCount === 0;
    selOpt.textContent = selCount > 0 ? `Selected pages (${selCount} selected)` : "Selected pages (none selected)";

    this.scopeSelect.value = "all";
    this.rangeWrap.hidden = true;
    this.rangeInput.value = `1-${total}`;
    this.rangeStatus.textContent = "";
    this.setError(null);
  }

  private switchKind(kind: BatchOverlayKind) {
    this.activeKind = kind;
    for (const btn of this.kindButtons) {
      btn.setAttribute("aria-selected", String(btn.dataset.kind === kind));
    }

    this.watermarkSection.hidden = kind !== "watermark";
    this.pageNumbersSection.hidden = kind !== "page_numbers";
    this.headerFooterSection.hidden = kind !== "header_footer";
    this.batesSection.hidden = kind !== "bates";

    this.positionField.hidden = kind === "header_footer";
    this.rotationField.hidden = kind !== "watermark";
    this.marginField.hidden = kind === "watermark";

    if (kind === "watermark") {
      this.positionSelect.value = "center";
      this.fontSizeInput.value = "48";
      this.colorInput.value = "#dc2626";
      this.opacityInput.value = "0.25";
      this.opacityVal.textContent = "25%";
    } else if (kind === "page_numbers") {
      this.positionSelect.value = "bottom_center";
      this.fontSizeInput.value = "11";
      this.colorInput.value = "#252524";
      this.opacityInput.value = "1";
      this.opacityVal.textContent = "100%";
    } else if (kind === "header_footer") {
      this.fontSizeInput.value = "10";
      this.colorInput.value = "#252524";
      this.opacityInput.value = "1";
      this.opacityVal.textContent = "100%";
    } else if (kind === "bates") {
      this.positionSelect.value = "bottom_right";
      this.fontSizeInput.value = "10";
      this.colorInput.value = "#252524";
      this.opacityInput.value = "1";
      this.opacityVal.textContent = "100%";
    }
    const colorLabel = this.dialog.querySelector("#wm-color-label");
    if (colorLabel) colorLabel.textContent = this.colorInput.value;
    this.setError(null);
  }

  private setError(message: string | null) {
    this.errorEl.hidden = !message;
    this.errorEl.textContent = message ?? "";
  }

  private async handleSubmit() {
    if (this.busy || !editorState.doc) return;
    const doc = editorState.doc;

    const scopeMode = this.scopeSelect.value as PageScopeMode;
    let pages: number[] | null = null;
    if (scopeMode !== "all") {
      try {
        pages = await resolvePageSelection(
          scopeMode,
          this.rangeInput.value,
          editorState.currentPage,
          editorState.selectedPages,
          doc.page_count
        );
      } catch (err) {
        this.setError(err instanceof Error ? err.message : String(err));
        return;
      }
    }

    const fontSize = Number(this.fontSizeInput.value);
    const opacity = Number(this.opacityInput.value);
    const margin = Number(this.marginInput.value);
    const position = this.positionSelect.value as BatchOverlayPosition;

    const options: BatchOverlayOptions = {
      kind: this.activeKind,
      pages,
      position,
      font_size: Number.isFinite(fontSize) && fontSize > 0 ? fontSize : null,
      color: this.colorInput.value,
      opacity: Number.isFinite(opacity) ? opacity : 1,
      margin: Number.isFinite(margin) ? margin : 28,
    };

    if (this.activeKind === "watermark") {
      const text = this.wmTextInput.value.trim();
      if (!text) {
        this.setError("Enter watermark text.");
        return;
      }
      options.text = text;
      options.rotation = Number(this.wmRotationInput.value);
    } else if (this.activeKind === "page_numbers") {
      const template = this.pnTemplateInput.value.trim() || "Page {page} of {total}";
      options.text = template;
    } else if (this.activeKind === "header_footer") {
      const hl = this.hfHeaderLeft.value.trim() || null;
      const hc = this.hfHeaderCenter.value.trim() || null;
      const hr = this.hfHeaderRight.value.trim() || null;
      const fl = this.hfFooterLeft.value.trim() || null;
      const fc = this.hfFooterCenter.value.trim() || null;
      const fr = this.hfFooterRight.value.trim() || null;
      if (!hl && !hc && !hr && !fl && !fc && !fr) {
        this.setError("Enter text in at least one header or footer slot.");
        return;
      }
      options.header_left = hl;
      options.header_center = hc;
      options.header_right = hr;
      options.footer_left = fl;
      options.footer_center = fc;
      options.footer_right = fr;
    } else if (this.activeKind === "bates") {
      const start = parseInt(this.batesStartInput.value, 10);
      const digits = parseInt(this.batesDigitsInput.value, 10);
      if (!Number.isFinite(start) || start < 0) {
        this.setError("Bates start number must be 0 or greater.");
        return;
      }
      if (!Number.isFinite(digits) || digits < 1 || digits > 12) {
        this.setError("Bates digits must be between 1 and 12.");
        return;
      }
      options.bates_prefix = this.batesPrefixInput.value;
      options.bates_start = start;
      options.bates_digits = digits;
    }

    this.busy = true;
    this.submitBtn.disabled = true;
    this.submitBtn.textContent = "Applying...";
    try {
      const updated = await Backend.applyWatermarkOrPageNumbers(options);
      editorState.updateDocument(updated);
      toast.show({ message: "Applied overlay to document.", type: "success" });
      this.close();
    } catch (err) {
      this.setError(String(err));
      toast.show({ message: `Could not apply overlay: ${String(err)}`, type: "error" });
    } finally {
      this.busy = false;
      this.submitBtn.disabled = false;
      this.submitBtn.textContent = "Apply to document";
    }
  }
}

let watermarkModalInstance: WatermarkModalView | null = null;

export function initWatermarkModal(): WatermarkModalView {
  if (!watermarkModalInstance) {
    watermarkModalInstance = new WatermarkModalView();
  }
  return watermarkModalInstance;
}

if (typeof document !== "undefined") {
  initWatermarkModal();
}

