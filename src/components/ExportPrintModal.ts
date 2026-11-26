/// <reference types="vite/client" />
import { FolderOpen, ImageDown, Printer, X } from "lucide";
import { Backend } from "../ipc/backend";
import { editorState } from "../state/editorState";
import { createRangePreviewer, PageScopeMode, resolvePageSelection } from "./MergeSplitModal";
import { toast } from "./Toast";
import { icon } from "./ui/icon";
import { animateDialogSize, initSlidingTabs } from "./ui/modalMotion";
import "../styles/doc-tools.css";

export type ExportImageFormat = "png" | "jpeg";
export type ExportDpi = 72 | 150 | 300;

export function computePrintTargetWidth(pageWidthPt: number, dpi: number): number {
  const safePt = Number.isFinite(pageWidthPt) && pageWidthPt > 0 ? pageWidthPt : 612;
  const safeDpi = Number.isFinite(dpi) && dpi > 0 ? dpi : 150;
  return Math.max(100, Math.round((safePt / 72) * safeDpi));
}

export class ExportPrintModalView {
  private dialog: HTMLDialogElement;
  private tabExportBtn: HTMLButtonElement;
  private tabPrintBtn: HTMLButtonElement;
  private exportOptionsWrap: HTMLElement;
  private printOptionsWrap: HTMLElement;
  private scopeSelect: HTMLSelectElement;
  private rangeWrap: HTMLElement;
  private rangeInput: HTMLInputElement;
  private rangeStatus: HTMLElement;
  private pngBtn: HTMLButtonElement;
  private jpegBtn: HTMLButtonElement;
  private dpiButtons: HTMLButtonElement[];
  private dirInput: HTMLInputElement;
  private browseBtn: HTMLButtonElement;
  private printDpiSelect: HTMLSelectElement;
  private printProgressEl: HTMLElement;
  private errorEl: HTMLElement;
  private primaryBtn: HTMLButtonElement;

  private activeTab: "export" | "print" = "export";
  private slidingTabs: ReturnType<typeof initSlidingTabs>;
  private format: ExportImageFormat = "png";
  private dpi: ExportDpi = 150;
  private rangePreviewer: ReturnType<typeof createRangePreviewer>;
  private focusReturn: HTMLElement | null = null;
  private busy = false;
  private docVersion = editorState.documentVersion;

  constructor() {
    this.dialog = document.createElement("dialog");
    this.dialog.className = "doc-modal";
    this.dialog.setAttribute("aria-labelledby", "export-print-modal-title");
    this.dialog.innerHTML = `
      <div class="doc-modal-header">
        <div class="doc-modal-title-wrap">
          ${icon(ImageDown)}
          <h2 id="export-print-modal-title">Export &amp; print</h2>
        </div>
        <button type="button" class="ui-button ui-button--tool" data-close aria-label="Close export and print dialog">
          ${icon(X)}
        </button>
      </div>
      <div class="doc-modal-body">
        <div class="doc-modal-tabs" role="tablist" aria-label="Output mode">
          <button type="button" class="doc-modal-tab" role="tab" id="ep-tab-export" aria-selected="true" aria-controls="ep-panel-export">
            ${icon(ImageDown, 14)}
            <span>Export images</span>
          </button>
          <button type="button" class="doc-modal-tab" role="tab" id="ep-tab-print" aria-selected="false" aria-controls="ep-panel-print">
            ${icon(Printer, 14)}
            <span>Print</span>
          </button>
        </div>

        <div class="doc-field">
          <label class="doc-label" for="ep-scope">Pages</label>
          <select class="ui-input" id="ep-scope">
            <option value="all">All pages</option>
            <option value="current">Current page</option>
            <option value="selected">Selected pages</option>
            <option value="range">Custom page range</option>
          </select>
        </div>

        <div class="doc-field" id="ep-range-wrap" hidden>
          <label class="doc-label" for="ep-range">Page range expression</label>
          <input class="ui-input doc-tabular" id="ep-range" type="text" placeholder="e.g. 1-5, 8, odd, !3" autocomplete="off" />
          <p class="doc-hint doc-tabular" id="ep-range-status"></p>
        </div>

        <section id="ep-panel-export" role="tabpanel" aria-labelledby="ep-tab-export" class="flex flex-col gap-3">
          <div class="doc-form-grid">
            <div class="doc-field">
              <span class="doc-label">Image format</span>
              <div class="doc-segmented" role="group" aria-label="Image format">
                <button type="button" class="doc-segmented-btn" id="ep-fmt-png" aria-pressed="true">PNG</button>
                <button type="button" class="doc-segmented-btn" id="ep-fmt-jpeg" aria-pressed="false">JPEG</button>
              </div>
            </div>
            <div class="doc-field">
              <span class="doc-label">Resolution</span>
              <div class="doc-segmented" role="group" aria-label="Export DPI">
                <button type="button" class="doc-segmented-btn" data-dpi="72" aria-pressed="false">72 DPI</button>
                <button type="button" class="doc-segmented-btn" data-dpi="150" aria-pressed="true">150 DPI</button>
                <button type="button" class="doc-segmented-btn" data-dpi="300" aria-pressed="false">300 DPI</button>
              </div>
            </div>
          </div>

          <div class="doc-field">
            <label class="doc-label" for="ep-dir">Output directory</label>
            <div class="doc-path-row">
              <input class="ui-input" id="ep-dir" type="text" placeholder="Choose a destination folder..." readonly />
              <button type="button" class="ui-button ui-button--outline ui-button--sm" id="ep-browse">
                ${icon(FolderOpen, 14)}
                <span>Browse...</span>
              </button>
            </div>
          </div>
        </section>

        <section id="ep-panel-print" role="tabpanel" aria-labelledby="ep-tab-print" class="flex flex-col gap-3" hidden>
          <div class="doc-field">
            <label class="doc-label" for="ep-print-dpi">Print raster quality</label>
            <select class="ui-input" id="ep-print-dpi">
              <option value="150">Standard (150 DPI)</option>
              <option value="300">High quality (300 DPI)</option>
            </select>
          </div>
          <p class="doc-hint" id="ep-print-progress">Pages are rasterized with annotations and sent to the system print dialog.</p>
        </section>

        <p class="doc-error" id="ep-error" role="alert" hidden></p>
      </div>
      <div class="doc-modal-footer">
        <div class="doc-modal-footer-actions">
          <button type="button" class="ui-button ui-button--outline" data-close>Cancel</button>
          <button type="button" class="ui-button ui-button--default" id="ep-primary-btn">Export images</button>
        </div>
      </div>
    `;

    document.body.appendChild(this.dialog);

    this.tabExportBtn = this.dialog.querySelector("#ep-tab-export")!;
    this.tabPrintBtn = this.dialog.querySelector("#ep-tab-print")!;
    this.slidingTabs = initSlidingTabs(this.dialog.querySelector(".doc-modal-tabs")!, ".doc-modal-tab");
    this.exportOptionsWrap = this.dialog.querySelector("#ep-panel-export")!;
    this.printOptionsWrap = this.dialog.querySelector("#ep-panel-print")!;
    this.scopeSelect = this.dialog.querySelector("#ep-scope")!;
    this.rangeWrap = this.dialog.querySelector("#ep-range-wrap")!;
    this.rangeInput = this.dialog.querySelector("#ep-range")!;
    this.rangeStatus = this.dialog.querySelector("#ep-range-status")!;
    this.pngBtn = this.dialog.querySelector("#ep-fmt-png")!;
    this.jpegBtn = this.dialog.querySelector("#ep-fmt-jpeg")!;
    this.dpiButtons = Array.from(this.dialog.querySelectorAll<HTMLButtonElement>("[data-dpi]"));
    this.dirInput = this.dialog.querySelector("#ep-dir")!;
    this.browseBtn = this.dialog.querySelector("#ep-browse")!;
    this.printDpiSelect = this.dialog.querySelector("#ep-print-dpi")!;
    this.printProgressEl = this.dialog.querySelector("#ep-print-progress")!;
    this.errorEl = this.dialog.querySelector("#ep-error")!;
    this.primaryBtn = this.dialog.querySelector("#ep-primary-btn")!;
    this.rangePreviewer = createRangePreviewer(this.rangeStatus);

    this.bindEvents();
  }

  private bindEvents() {
    window.addEventListener("open-export-print", (event) => {
      const detail = (event as CustomEvent<{ tab?: "export" | "print" }>).detail;
      this.open(detail?.tab);
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

    this.tabExportBtn.addEventListener("click", () => this.switchTab("export"));
    this.tabPrintBtn.addEventListener("click", () => this.switchTab("print"));

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

    this.pngBtn.addEventListener("click", () => this.setFormat("png"));
    this.jpegBtn.addEventListener("click", () => this.setFormat("jpeg"));

    for (const btn of this.dpiButtons) {
      btn.addEventListener("click", () => {
        const val = Number(btn.dataset.dpi) as ExportDpi;
        if (val === 72 || val === 150 || val === 300) this.setDpi(val);
      });
    }

    this.browseBtn.addEventListener("click", () => void this.pickOutputDirectory());

    this.primaryBtn.addEventListener("click", () => {
      if (this.activeTab === "export") {
        void this.handleExport();
      } else {
        void this.handlePrint();
      }
    });

    editorState.subscribe(() => {
      if (this.docVersion !== editorState.documentVersion) {
        this.docVersion = editorState.documentVersion;
        if (this.dialog.open) this.close();
      }
    });
  }

  open(initialTab?: "export" | "print") {
    if (!editorState.doc || editorState.openingFile) {
      toast.show({ message: "Open a PDF document first.", type: "warning" });
      return;
    }
    this.focusReturn = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.populate();
    this.switchTab(initialTab ?? "export");
    if (!this.dialog.open) this.dialog.showModal();
  }

  close() {
    if (this.dialog.open) this.dialog.close();
  }

  private populate() {
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

    this.scopeSelect.value = selCount > 0 ? "selected" : "all";
    this.rangeWrap.hidden = true;
    this.rangeInput.value = `1-${total}`;
    this.rangeStatus.textContent = "";

    if (!this.dirInput.value && doc.file_path) {
      const idx = Math.max(doc.file_path.lastIndexOf("/"), doc.file_path.lastIndexOf("\\"));
      if (idx > 0) this.dirInput.value = doc.file_path.slice(0, idx);
    }

    this.printProgressEl.textContent = "Pages are rasterized with annotations and sent to the system print dialog.";
    this.setError(null);
  }

  private switchTab(tab: "export" | "print") {
    this.activeTab = tab;
    const isExport = tab === "export";
    const apply = () => {
      this.tabExportBtn.setAttribute("aria-selected", String(isExport));
      this.tabPrintBtn.setAttribute("aria-selected", String(!isExport));
      this.exportOptionsWrap.hidden = !isExport;
      this.printOptionsWrap.hidden = isExport;
      this.primaryBtn.textContent = isExport ? "Export images" : "Print...";
      this.setError(null);
    };
    if (this.dialog.open) animateDialogSize(this.dialog, apply);
    else apply();
    this.slidingTabs.update(!this.dialog.open);
  }

  private setFormat(fmt: ExportImageFormat) {
    this.format = fmt;
    this.pngBtn.setAttribute("aria-pressed", String(fmt === "png"));
    this.jpegBtn.setAttribute("aria-pressed", String(fmt === "jpeg"));
  }

  private setDpi(dpi: ExportDpi) {
    this.dpi = dpi;
    for (const btn of this.dpiButtons) {
      btn.setAttribute("aria-pressed", String(Number(btn.dataset.dpi) === dpi));
    }
  }

  private async pickOutputDirectory() {
    if (this.busy) return;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string" && selected) {
        this.dirInput.value = selected;
        this.setError(null);
      }
    } catch (err) {
      toast.show({ message: `Could not choose folder: ${String(err)}`, type: "error" });
    }
  }

  private setBusy(busy: boolean, label?: string) {
    this.busy = busy;
    this.primaryBtn.disabled = busy;
    this.browseBtn.disabled = busy;
    this.tabExportBtn.disabled = busy;
    this.tabPrintBtn.disabled = busy;
    if (busy && label) {
      this.primaryBtn.textContent = label;
    } else {
      this.primaryBtn.textContent = this.activeTab === "export" ? "Export images" : "Print...";
    }
  }

  private setError(message: string | null) {
    this.errorEl.hidden = !message;
    this.errorEl.textContent = message ?? "";
  }

  private async handleExport() {
    if (this.busy || !editorState.doc) return;
    const outputDir = this.dirInput.value.trim();
    if (!outputDir) {
      this.setError("Choose an output directory first.");
      return;
    }

    let pages: number[];
    try {
      pages = await resolvePageSelection(
        this.scopeSelect.value as PageScopeMode,
        this.rangeInput.value,
        editorState.currentPage,
        editorState.selectedPages,
        editorState.doc.page_count
      );
    } catch (err) {
      this.setError(err instanceof Error ? err.message : String(err));
      return;
    }

    this.setBusy(true, "Exporting...");
    try {
      const writtenPaths = await Backend.exportPagesAsImages(pages, outputDir, this.format, this.dpi);
      toast.show({
        message: `Exported ${writtenPaths.length} ${this.format.toUpperCase()} image${writtenPaths.length === 1 ? "" : "s"} to ${outputDir}.`,
        type: "success",
      });
      this.close();
    } catch (err) {
      this.setError(String(err));
      toast.show({ message: `Image export failed: ${String(err)}`, type: "error" });
    } finally {
      this.setBusy(false);
    }
  }

  private async handlePrint() {
    if (this.busy || !editorState.doc) return;
    const doc = editorState.doc;

    let pages: number[];
    try {
      pages = await resolvePageSelection(
        this.scopeSelect.value as PageScopeMode,
        this.rangeInput.value,
        editorState.currentPage,
        editorState.selectedPages,
        doc.page_count
      );
    } catch (err) {
      this.setError(err instanceof Error ? err.message : String(err));
      return;
    }

    const printDpi = Number(this.printDpiSelect.value) || 150;
    this.setBusy(true, "Preparing...");

    const objectUrls: string[] = [];
    const revokeAll = () => {
      for (const url of objectUrls) {
        if (url.startsWith("blob:")) URL.revokeObjectURL(url);
      }
      objectUrls.length = 0;
    };

    try {
      document.getElementById("doc-print-sheet")?.remove();
      const printSheet = document.createElement("div");
      printSheet.id = "doc-print-sheet";

      const images: HTMLImageElement[] = [];
      for (let i = 0; i < pages.length; i++) {
        const pageIndex = pages[i];
        this.printProgressEl.textContent = `Preparing page ${i + 1} of ${pages.length}...`;
        const pageInfo = doc.pages[pageIndex];
        const targetWidth = computePrintTargetWidth(pageInfo?.width ?? 612, printDpi);
        const dataUrl = await Backend.renderPage(pageIndex, targetWidth);
        objectUrls.push(dataUrl);

        const pageWrap = document.createElement("div");
        pageWrap.className = "doc-print-page";
        const img = document.createElement("img");
        img.alt = `Page ${pageIndex + 1}`;
        img.src = dataUrl;
        pageWrap.appendChild(img);
        printSheet.appendChild(pageWrap);
        images.push(img);
      }

      document.body.appendChild(printSheet);
      await Promise.allSettled(images.map((img) => img.decode()));

      const cleanup = () => {
        printSheet.remove();
        revokeAll();
        window.removeEventListener("afterprint", cleanup);
      };
      window.addEventListener("afterprint", cleanup, { once: true });

      this.setBusy(false);
      this.close();
      window.print();
    } catch (err) {
      revokeAll();
      document.getElementById("doc-print-sheet")?.remove();
      this.setError(String(err));
      toast.show({ message: `Print preparation failed: ${String(err)}`, type: "error" });
      this.setBusy(false);
    }
  }
}

let exportPrintModalInstance: ExportPrintModalView | null = null;

export function initExportPrintModal(): ExportPrintModalView {
  if (!exportPrintModalInstance) {
    exportPrintModalInstance = new ExportPrintModalView();
  }
  return exportPrintModalInstance;
}

if (typeof document !== "undefined") {
  initExportPrintModal();
}

