import { ChevronDown, ChevronUp, Search, ShieldAlert, X } from "lucide";
import { Backend } from "../ipc/backend";
import { editorState } from "../state/editorState";
import type { AreaRedactItem, SearchResult } from "../types/editor";
import { jumpToPage } from "./EditorContextMenu";
import { toast } from "./Toast";
import { icon } from "./ui/icon";

export class DocumentSearchView {
  private dialog = document.createElement("dialog");
  private input: HTMLInputElement;
  private status: HTMLElement;
  private previous: HTMLButtonElement;
  private next: HTMLButtonElement;
  private matchCaseInput: HTMLInputElement;
  private regexInput: HTMLInputElement;
  private redactAllBtn: HTMLButtonElement;
  private results: SearchResult[] = [];
  private active = -1;
  private request = 0;
  private timer = 0;
  private query = "";
  private focusReturn: HTMLElement | null = null;

  constructor() {
    this.dialog.className = "document-search";
    this.dialog.setAttribute("aria-label", "Find in document");
    this.dialog.innerHTML = `
      <form class="document-search-form">
        ${icon(Search)}
        <input class="ui-input" type="search" aria-label="Find text or regex in PDF" placeholder="Find in document" autocomplete="off">
        <button class="ui-button ui-button--tool" type="button" aria-label="Previous match" data-previous>${icon(ChevronUp)}</button>
        <button class="ui-button ui-button--tool" type="button" aria-label="Next match" data-next>${icon(ChevronDown)}</button>
        <button class="ui-button ui-button--tool" type="button" aria-label="Close search" data-close>${icon(X)}</button>
      </form>
      <div class="document-search-meta">
        <span role="status"></span>
        <div class="document-search-options">
          <label class="ui-check"><input type="checkbox" data-match-case> Match case</label>
          <label class="ui-check" title="Regular expression search (e.g. emails, phone numbers)"><input type="checkbox" data-regex> Regex</label>
        </div>
      </div>
      <div class="document-search-actions" hidden>
        <button class="ui-button ui-button--destructive document-search-redact-btn" type="button" data-redact-all>
          ${icon(ShieldAlert, 14)}
          <span>Redact all matches</span>
        </button>
      </div>`;
    document.body.appendChild(this.dialog);
    this.input = this.dialog.querySelector("input[type=search]")!;
    this.status = this.dialog.querySelector("[role=status]")!;
    this.previous = this.dialog.querySelector("[data-previous]")!;
    this.next = this.dialog.querySelector("[data-next]")!;
    this.matchCaseInput = this.dialog.querySelector("[data-match-case]")!;
    this.regexInput = this.dialog.querySelector("[data-regex]")!;
    this.redactAllBtn = this.dialog.querySelector("[data-redact-all]")!;
    this.previous.onclick = () => this.step(-1);
    this.next.onclick = () => this.step(1);
    this.redactAllBtn.onclick = () => void this.redactAllMatches();
    this.dialog.querySelector("[data-close]")!.addEventListener("click", () => this.close());
    this.dialog.querySelector("form")!.addEventListener("submit", (event) => {
      event.preventDefault();
      if (this.query !== this.input.value.trim()) void this.search();
    });
    this.input.addEventListener("input", () => {
      this.invalidate();
      this.timer = window.setTimeout(() => void this.search(), 200);
    });
    this.matchCaseInput.addEventListener("change", () => void this.search());
    this.regexInput.addEventListener("change", () => void this.search());
    window.addEventListener("open-document-search", () => this.open());
    window.addEventListener("keydown", (event) => {
      if (event.key.toLowerCase() === "f" && (event.ctrlKey || event.metaKey) && editorState.doc && !editorState.openingFile) {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.open();
      } else if (this.dialog.open && event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.close();
      } else if (this.dialog.open && event.target === this.input && event.key === "Enter") {
        event.preventDefault();
        if (this.query !== this.input.value.trim()) void this.search();
        else this.step(event.shiftKey ? -1 : 1);
      }
    }, { capture: true });
    let version = editorState.documentVersion;
    let rasterVersion = editorState.rasterVersion;
    editorState.subscribe(() => {
      if (version !== editorState.documentVersion) {
        version = editorState.documentVersion;
        this.close();
      } else if (rasterVersion !== editorState.rasterVersion && this.dialog.open) {
        void this.search();
      }
      rasterVersion = editorState.rasterVersion;
    });
    this.renderStatus("");
  }

  private open() {
    if (!editorState.doc || editorState.openingFile) return;
    if (!this.dialog.open) {
      this.focusReturn = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      this.dialog.show();
      if (this.input.value.trim()) void this.search();
    }
    this.input.focus();
    this.input.select();
  }

  private close() {
    if (!this.dialog.open) return;
    this.dialog.close();
    this.invalidate();
    if (this.focusReturn?.isConnected) this.focusReturn.focus({ preventScroll: true });
  }

  private invalidate() {
    clearTimeout(this.timer);
    this.request++;
    this.query = "";
    this.results = [];
    this.active = -1;
    window.dispatchEvent(new CustomEvent("document-search-result", { detail: null }));
    this.renderStatus("");
  }

  private async search() {
    this.invalidate();
    const query = this.input.value.trim();
    if (!query || !this.dialog.open) return;
    this.query = query;
    const request = this.request;
    const caseSensitive = this.matchCaseInput.checked;
    const isRegex = this.regexInput.checked;
    this.renderStatus("Searching…");
    try {
      const results = await Backend.searchDocument(query, caseSensitive, isRegex);
      if (request !== this.request) return;
      this.results = results;
      if (results.length) {
        const first = results.findIndex(({ page_index }) => page_index >= editorState.currentPage);
        this.active = (first < 0 ? results.length : first) - 1;
        this.step(1);
      } else {
        this.renderStatus("No matches");
      }
    } catch (error) {
      if (request === this.request) this.renderStatus(`Could not search: ${String(error)}`);
    }
  }

  private async redactAllMatches() {
    if (!this.results.length || !editorState.doc) return;
    const items: AreaRedactItem[] = [];
    for (const res of this.results) {
      for (const rect of res.bounding_boxes) {
        items.push({ page_index: res.page_index, rect });
      }
    }
    if (!items.length) return;
    const matchCount = this.results.length;
    const docVer = editorState.documentVersion;
    this.redactAllBtn.disabled = true;
    try {
      const updated = await Backend.applyAreaRedactions(items);
      if (editorState.documentVersion === docVer) {
        editorState.updateDocument(updated);
      }
      toast.show({
        message: `Redacted ${matchCount} match${matchCount === 1 ? "" : "es"} permanently.`,
        type: "success",
      });
    } catch (error) {
      toast.show({ message: `Could not redact matches: ${String(error)}`, type: "error" });
    } finally {
      this.redactAllBtn.disabled = false;
    }
  }

  private step(direction: number) {
    if (!this.results.length) return;
    this.active = (this.active + direction + this.results.length) % this.results.length;
    const hit = this.results[this.active];
    jumpToPage(hit.page_index);
    window.dispatchEvent(new CustomEvent<SearchResult>("document-search-result", { detail: hit }));
    this.renderStatus(`${this.active + 1} of ${this.results.length} · Page ${hit.page_index + 1}`);
  }

  private renderStatus(message: string) {
    this.status.textContent = message;
    this.previous.disabled = this.next.disabled = !this.results.length;
    const actionsRow = this.dialog.querySelector<HTMLElement>(".document-search-actions");
    if (actionsRow) {
      actionsRow.hidden = this.results.length === 0;
      const label = this.redactAllBtn.querySelector("span");
      if (label) {
        label.textContent = `Redact all (${this.results.length})`;
      }
    }
  }
}
