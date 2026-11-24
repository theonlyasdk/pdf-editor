/// <reference types="vite/client" />
import { ArrowDown, ArrowUp, FilePlus, Layers, Scissors, Trash2, X } from "lucide";
import { Backend } from "../ipc/backend";
import { editorState } from "../state/editorState";
import { toast } from "./Toast";
import { icon } from "./ui/icon";
import "../styles/doc-tools.css";

export type PageScopeMode = "all" | "current" | "selected" | "range";
export type MergeInsertMode = "end" | "start" | "before-current" | "after-current" | "custom";

export async function resolvePageSelection(
  mode: PageScopeMode,
  rangeExpression: string,
  currentPage: number,
  selectedPages: Set<number>,
  totalPages: number
): Promise<number[]> {
  if (totalPages <= 0) return [];
  if (mode === "all") {
    return Array.from({ length: totalPages }, (_, i) => i);
  }
  if (mode === "current") {
    return [Math.max(0, Math.min(totalPages - 1, currentPage))];
  }
  if (mode === "selected") {
    const pages = Array.from(selectedPages)
      .filter((p) => p >= 0 && p < totalPages)
      .sort((a, b) => a - b);
    if (pages.length === 0) {
      throw new Error("No pages are currently selected.");
    }
    return pages;
  }
  const expr = rangeExpression.trim();
  if (!expr) {
    throw new Error("Enter a page range expression (for example: 1-5, 8, odd).");
  }
  const pages = await Backend.evaluateRange(expr, totalPages);
  if (pages.length === 0) {
    throw new Error("The page range matched 0 pages.");
  }
  return pages;
}

export function formatPageNumbersSummary(pages: number[], maxShown = 8): string {
  if (pages.length === 0) return "0 pages";
  const oneBased = pages.map((p) => p + 1);
  const shown = oneBased.slice(0, maxShown).join(", ");
  const suffix = oneBased.length > maxShown ? `, … (+${oneBased.length - maxShown} more)` : "";
  return `${pages.length} page${pages.length === 1 ? "" : "s"} (${shown}${suffix})`;
}

export function createRangePreviewer(statusEl: HTMLElement) {
  let timer = 0;
  let requestId = 0;

  const evaluateNow = async (expr: string) => {
    const doc = editorState.doc;
    if (!doc) return;
    const trimmed = expr.trim();
    if (!trimmed) {
      statusEl.textContent = "Enter pages or ranges, e.g. 1-5, 8, odd, !3.";
      return;
    }
    const id = ++requestId;
    try {
      const pages = await Backend.evaluateRange(trimmed, doc.page_count);
      if (id !== requestId) return;
      statusEl.textContent = `Matches ${formatPageNumbersSummary(pages)}`;
    } catch (err) {
      if (id !== requestId) return;
      statusEl.textContent = String(err);
    }
  };

  return {
    schedule(expr: string, delayMs = 200) {
      clearTimeout(timer);
      timer = window.setTimeout(() => void evaluateNow(expr), delayMs);
    },
    evaluateNow,
    cancel() {
      clearTimeout(timer);
      requestId++;
    },
  };
}

export function resolveMergeInsertAt(
  mode: MergeInsertMode,
  currentPage: number,
  totalPages: number,
  customOneBased: number
): number | null {
  switch (mode) {
    case "end":
      return null;
    case "start":
      return 0;
    case "before-current":
      return Math.max(0, Math.min(totalPages, currentPage));
    case "after-current":
      return Math.max(0, Math.min(totalPages, currentPage + 1));
    case "custom": {
      if (!Number.isFinite(customOneBased) || customOneBased < 1 || customOneBased > totalPages + 1) {
        throw new Error(`Enter a page position between 1 and ${totalPages + 1}.`);
      }
      return Math.floor(customOneBased) - 1;
    }
  }
}

export function buildExtractDefaultFilename(fileName: string): string {
  const stem = fileName.replace(/\.pdf$/i, "") || "document";
  return `${stem}-extracted.pdf`;
}

export class MergeSplitModalView {
  private dialog: HTMLDialogElement;
  private tabMergeBtn: HTMLButtonElement;
  private tabExtractBtn: HTMLButtonElement;
  private mergePanel: HTMLElement;
  private extractPanel: HTMLElement;
  private fileListEl: HTMLElement;
  private addFilesBtn: HTMLButtonElement;
  private insertModeSelect: HTMLSelectElement;
  private customPosWrap: HTMLElement;
  private customPosInput: HTMLInputElement;
  private extractScopeSelect: HTMLSelectElement;
  private extractRangeWrap: HTMLElement;
  private extractRangeInput: HTMLInputElement;
  private extractRangeStatus: HTMLElement;
  private errorEl: HTMLElement;
  private primaryBtn: HTMLButtonElement;

  private activeTab: "merge" | "extract" = "merge";
  private mergePaths: string[] = [];
  private rangePreviewer: ReturnType<typeof createRangePreviewer>;
  private focusReturn: HTMLElement | null = null;
  private busy = false;
  private docVersion = editorState.documentVersion;

  constructor() {
    this.dialog = document.createElement("dialog");
    this.dialog.className = "doc-modal doc-modal--wide";
    this.dialog.setAttribute("aria-labelledby", "merge-split-modal-title");
    this.dialog.innerHTML = `
      <div class="doc-modal-header">
        <div class="doc-modal-title-wrap">
          ${icon(Layers)}
          <h2 id="merge-split-modal-title">Merge &amp; split pages</h2>
        </div>
        <button type="button" class="ui-button ui-button--tool" data-close aria-label="Close merge and split dialog">
          ${icon(X)}
        </button>
      </div>
      <div class="doc-modal-body">
        <div class="doc-modal-tabs" role="tablist" aria-label="Document operation">
          <button type="button" class="doc-modal-tab" role="tab" id="ms-tab-merge" aria-selected="true" aria-controls="ms-panel-merge">
            ${icon(FilePlus, 14)}
            <span>Merge / insert PDF</span>
          </button>
          <button type="button" class="doc-modal-tab" role="tab" id="ms-tab-extract" aria-selected="false" aria-controls="ms-panel-extract">
            ${icon(Scissors, 14)}
            <span>Extract / split pages</span>
          </button>
        </div>

        <section id="ms-panel-merge" role="tabpanel" aria-labelledby="ms-tab-merge" class="flex flex-col gap-3">
          <div class="flex items-center justify-between gap-2">
            <span class="doc-label">PDF files to insert</span>
            <button type="button" class="ui-button ui-button--outline ui-button--sm" id="ms-add-files">
              ${icon(FilePlus, 14)}
              <span>Add PDF file(s)...</span>
            </button>
          </div>
          <div class="doc-file-list" id="ms-file-list"></div>

          <div class="doc-form-grid">
            <div class="doc-field">
              <label class="doc-label" for="ms-insert-mode">Insert position</label>
              <select class="ui-input" id="ms-insert-mode">
                <option value="end">Append to end</option>
                <option value="start">Insert at start</option>
                <option value="before-current">Before current page</option>
                <option value="after-current">After current page</option>
                <option value="custom">Custom page position...</option>
              </select>
            </div>
            <div class="doc-field" id="ms-custom-pos-wrap" hidden>
              <label class="doc-label" for="ms-custom-pos">Before page number (1-based)</label>
              <input class="ui-input doc-tabular" id="ms-custom-pos" type="number" min="1" step="1" value="1" />
            </div>
          </div>
        </section>

        <section id="ms-panel-extract" role="tabpanel" aria-labelledby="ms-tab-extract" class="flex flex-col gap-3" hidden>
          <div class="doc-field">
            <label class="doc-label" for="ms-extract-scope">Pages to extract</label>
            <select class="ui-input" id="ms-extract-scope">
              <option value="selected">Selected pages</option>
              <option value="current">Current page</option>
              <option value="all">All pages</option>
              <option value="range">Custom page range</option>
            </select>
          </div>

          <div class="doc-field" id="ms-extract-range-wrap" hidden>
            <label class="doc-label" for="ms-extract-range">Page range expression</label>
            <input class="ui-input doc-tabular" id="ms-extract-range" type="text" placeholder="e.g. 1-5, 8, odd, last-2, !3" autocomplete="off" />
            <p class="doc-hint doc-tabular" id="ms-extract-range-status"></p>
          </div>

          <p class="doc-hint">Extracts the chosen pages into a new PDF file without modifying the open document.</p>
        </section>

        <p class="doc-error" id="ms-error" role="alert" hidden></p>
      </div>
      <div class="doc-modal-footer">
        <div class="doc-modal-footer-actions">
          <button type="button" class="ui-button ui-button--outline" data-close>Cancel</button>
          <button type="button" class="ui-button ui-button--default" id="ms-primary-btn">Merge PDFs</button>
        </div>
      </div>
    `;

    document.body.appendChild(this.dialog);

    this.tabMergeBtn = this.dialog.querySelector("#ms-tab-merge")!;
    this.tabExtractBtn = this.dialog.querySelector("#ms-tab-extract")!;
    this.mergePanel = this.dialog.querySelector("#ms-panel-merge")!;
    this.extractPanel = this.dialog.querySelector("#ms-panel-extract")!;
    this.fileListEl = this.dialog.querySelector("#ms-file-list")!;
    this.addFilesBtn = this.dialog.querySelector("#ms-add-files")!;
    this.insertModeSelect = this.dialog.querySelector("#ms-insert-mode")!;
    this.customPosWrap = this.dialog.querySelector("#ms-custom-pos-wrap")!;
    this.customPosInput = this.dialog.querySelector("#ms-custom-pos")!;
    this.extractScopeSelect = this.dialog.querySelector("#ms-extract-scope")!;
    this.extractRangeWrap = this.dialog.querySelector("#ms-extract-range-wrap")!;
    this.extractRangeInput = this.dialog.querySelector("#ms-extract-range")!;
    this.extractRangeStatus = this.dialog.querySelector("#ms-extract-range-status")!;
    this.errorEl = this.dialog.querySelector("#ms-error")!;
    this.primaryBtn = this.dialog.querySelector("#ms-primary-btn")!;
    this.rangePreviewer = createRangePreviewer(this.extractRangeStatus);

    this.bindEvents();
  }

  private bindEvents() {
    window.addEventListener("open-merge-split", (event) => {
      const detail = (event as CustomEvent<{ tab?: "merge" | "extract" }>).detail;
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

    this.tabMergeBtn.addEventListener("click", () => this.switchTab("merge"));
    this.tabExtractBtn.addEventListener("click", () => this.switchTab("extract"));

    this.addFilesBtn.addEventListener("click", () => void this.pickMergeFiles());

    this.insertModeSelect.addEventListener("change", () => {
      this.customPosWrap.hidden = this.insertModeSelect.value !== "custom";
      this.setError(null);
    });

    this.extractScopeSelect.addEventListener("change", () => {
      const isRange = this.extractScopeSelect.value === "range";
      this.extractRangeWrap.hidden = !isRange;
      this.setError(null);
      if (isRange) void this.rangePreviewer.evaluateNow(this.extractRangeInput.value);
    });

    this.extractRangeInput.addEventListener("input", () => {
      this.setError(null);
      this.rangePreviewer.schedule(this.extractRangeInput.value);
    });

    this.primaryBtn.addEventListener("click", () => {
      if (this.activeTab === "merge") {
        void this.handleMerge();
      } else {
        void this.handleExtract();
      }
    });

    editorState.subscribe(() => {
      if (this.docVersion !== editorState.documentVersion) {
        this.docVersion = editorState.documentVersion;
        if (this.dialog.open) this.close();
      }
    });
  }

  open(initialTab?: "merge" | "extract") {
    if (!editorState.doc || editorState.openingFile) {
      toast.show({ message: "Open a PDF document first.", type: "warning" });
      return;
    }
    this.focusReturn = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.mergePaths = [];
    this.setError(null);
    this.populate();
    this.switchTab(initialTab ?? (editorState.selectedPages.size > 0 ? "extract" : "merge"));
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

    const endOpt = this.insertModeSelect.querySelector<HTMLOptionElement>('option[value="end"]')!;
    const beforeOpt = this.insertModeSelect.querySelector<HTMLOptionElement>('option[value="before-current"]')!;
    const afterOpt = this.insertModeSelect.querySelector<HTMLOptionElement>('option[value="after-current"]')!;
    endOpt.textContent = `Append to end (after Page ${total})`;
    beforeOpt.textContent = `Before current page (Page ${cur})`;
    afterOpt.textContent = `After current page (Page ${cur})`;
    this.insertModeSelect.value = "end";
    this.customPosWrap.hidden = true;
    this.customPosInput.max = String(total + 1);
    this.customPosInput.value = String(cur + 1);

    const selOpt = this.extractScopeSelect.querySelector<HTMLOptionElement>('option[value="selected"]')!;
    const curOpt = this.extractScopeSelect.querySelector<HTMLOptionElement>('option[value="current"]')!;
    const allOpt = this.extractScopeSelect.querySelector<HTMLOptionElement>('option[value="all"]')!;
    selOpt.disabled = selCount === 0;
    selOpt.textContent = selCount > 0 ? `Selected pages (${selCount} selected)` : "Selected pages (none selected)";
    curOpt.textContent = `Current page (Page ${cur})`;
    allOpt.textContent = `All pages (1–${total})`;

    this.extractScopeSelect.value = selCount > 0 ? "selected" : "range";
    this.extractRangeWrap.hidden = this.extractScopeSelect.value !== "range";
    this.extractRangeInput.value = `1-${total}`;
    this.extractRangeStatus.textContent = "";
    if (this.extractScopeSelect.value === "range") {
      void this.rangePreviewer.evaluateNow(this.extractRangeInput.value);
    }

    this.renderMergeFileList();
  }

  private switchTab(tab: "merge" | "extract") {
    this.activeTab = tab;
    const isMerge = tab === "merge";
    this.tabMergeBtn.setAttribute("aria-selected", String(isMerge));
    this.tabExtractBtn.setAttribute("aria-selected", String(!isMerge));
    this.mergePanel.hidden = !isMerge;
    this.extractPanel.hidden = isMerge;
    this.primaryBtn.textContent = isMerge ? "Merge PDFs" : "Extract to PDF...";
    this.setError(null);
  }

  private renderMergeFileList() {
    this.fileListEl.innerHTML = "";
    if (this.mergePaths.length === 0) {
      const empty = document.createElement("p");
      empty.className = "doc-hint";
      empty.textContent = "No PDF files selected yet. Choose one or more files to insert.";
      this.fileListEl.appendChild(empty);
      return;
    }

    this.mergePaths.forEach((filePath, index) => {
      const row = document.createElement("div");
      row.className = "doc-file-row";

      const badge = document.createElement("span");
      badge.className = "ui-badge doc-tabular";
      badge.textContent = String(index + 1);

      const name = document.createElement("span");
      name.className = "doc-file-name";
      name.textContent = filePath.split(/[\\/]/).pop() || filePath;
      name.title = filePath;

      const upBtn = document.createElement("button");
      upBtn.type = "button";
      upBtn.className = "ui-button ui-button--tool ui-button--sm";
      upBtn.setAttribute("aria-label", `Move ${name.textContent} up`);
      upBtn.disabled = index === 0;
      upBtn.innerHTML = icon(ArrowUp, 14);
      upBtn.onclick = () => {
        const tmp = this.mergePaths[index - 1];
        this.mergePaths[index - 1] = this.mergePaths[index];
        this.mergePaths[index] = tmp;
        this.renderMergeFileList();
      };

      const downBtn = document.createElement("button");
      downBtn.type = "button";
      downBtn.className = "ui-button ui-button--tool ui-button--sm";
      downBtn.setAttribute("aria-label", `Move ${name.textContent} down`);
      downBtn.disabled = index === this.mergePaths.length - 1;
      downBtn.innerHTML = icon(ArrowDown, 14);
      downBtn.onclick = () => {
        const tmp = this.mergePaths[index + 1];
        this.mergePaths[index + 1] = this.mergePaths[index];
        this.mergePaths[index] = tmp;
        this.renderMergeFileList();
      };

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "ui-button ui-button--tool ui-button--sm text-destructive";
      removeBtn.setAttribute("aria-label", `Remove ${name.textContent}`);
      removeBtn.innerHTML = icon(Trash2, 14);
      removeBtn.onclick = () => {
        this.mergePaths.splice(index, 1);
        this.renderMergeFileList();
      };

      row.append(badge, name, upBtn, downBtn, removeBtn);
      this.fileListEl.appendChild(row);
    });
  }

  private async pickMergeFiles() {
    if (this.busy) return;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selection = await open({
        multiple: true,
        filters: [{ name: "PDF Files", extensions: ["pdf"] }],
      });
      if (!selection) return;
      const picked = Array.isArray(selection) ? selection : [selection];
      if (picked.length > 0) {
        this.mergePaths.push(...picked);
        this.renderMergeFileList();
        this.setError(null);
      }
    } catch (err) {
      toast.show({ message: `Could not open file picker: ${String(err)}`, type: "error" });
    }
  }

  private setBusy(busy: boolean, label?: string) {
    this.busy = busy;
    this.primaryBtn.disabled = busy;
    this.addFilesBtn.disabled = busy;
    this.tabMergeBtn.disabled = busy;
    this.tabExtractBtn.disabled = busy;
    if (busy && label) {
      this.primaryBtn.textContent = label;
    } else {
      this.primaryBtn.textContent = this.activeTab === "merge" ? "Merge PDFs" : "Extract to PDF...";
    }
  }

  private setError(message: string | null) {
    this.errorEl.hidden = !message;
    this.errorEl.textContent = message ?? "";
  }

  private async handleMerge() {
    if (this.busy || !editorState.doc) return;
    if (this.mergePaths.length === 0) {
      this.setError("Select at least one PDF file to merge.");
      return;
    }

    let insertAt: number | null;
    try {
      insertAt = resolveMergeInsertAt(
        this.insertModeSelect.value as MergeInsertMode,
        editorState.currentPage,
        editorState.doc.page_count,
        parseInt(this.customPosInput.value, 10)
      );
    } catch (err) {
      this.setError(err instanceof Error ? err.message : String(err));
      return;
    }

    this.setBusy(true, "Merging...");
    try {
      const updated = await Backend.mergePdf(this.mergePaths, insertAt);
      editorState.updateDocument(updated);
      toast.show({
        message: `Merged ${this.mergePaths.length} PDF file${this.mergePaths.length === 1 ? "" : "s"}.`,
        type: "success",
      });
      this.close();
    } catch (err) {
      this.setError(String(err));
      toast.show({ message: `Merge failed: ${String(err)}`, type: "error" });
    } finally {
      this.setBusy(false);
    }
  }

  private async handleExtract() {
    if (this.busy || !editorState.doc) return;
    let pages: number[];
    try {
      pages = await resolvePageSelection(
        this.extractScopeSelect.value as PageScopeMode,
        this.extractRangeInput.value,
        editorState.currentPage,
        editorState.selectedPages,
        editorState.doc.page_count
      );
    } catch (err) {
      this.setError(err instanceof Error ? err.message : String(err));
      return;
    }

    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const targetPath = await save({
        defaultPath: buildExtractDefaultFilename(editorState.doc.file_name),
        filters: [{ name: "PDF Document", extensions: ["pdf"] }],
      });
      if (!targetPath || typeof targetPath !== "string") return;

      this.setBusy(true, "Extracting...");
      await Backend.extractPages(pages, targetPath);
      toast.show({
        message: `Extracted ${pages.length} page${pages.length === 1 ? "" : "s"} to ${targetPath}.`,
        type: "success",
      });
      this.close();
    } catch (err) {
      this.setError(String(err));
      toast.show({ message: `Extract failed: ${String(err)}`, type: "error" });
    } finally {
      this.setBusy(false);
    }
  }
}

let mergeSplitModalInstance: MergeSplitModalView | null = null;

export function initMergeSplitModal(): MergeSplitModalView {
  if (!mergeSplitModalInstance) {
    mergeSplitModalInstance = new MergeSplitModalView();
  }
  return mergeSplitModalInstance;
}

if (typeof document !== "undefined") {
  initMergeSplitModal();
}

