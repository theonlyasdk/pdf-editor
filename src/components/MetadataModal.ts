/// <reference types="vite/client" />
import { FolderOpen, Info, ShieldAlert, X } from "lucide";
import { Backend, DocumentMetadataUpdate } from "../ipc/backend";
import { editorState } from "../state/editorState";
import { initExportPrintModal } from "./ExportPrintModal";
import { initInsertPageModal } from "./InsertPageModal";
import { initMergeSplitModal } from "./MergeSplitModal";
import { toast } from "./Toast";
import { icon } from "./ui/icon";
import { initWatermarkModal } from "./WatermarkModal";
import "../styles/doc-tools.css";

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIdx = 0;
  while (value >= 1024 && unitIdx < units.length - 1) {
    value /= 1024;
    unitIdx++;
  }
  return unitIdx === 0 ? `${Math.round(value)} B` : `${value.toFixed(2)} ${units[unitIdx]}`;
}

export function normalizeMetadataField(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export class MetadataModalView {
  private dialog: HTMLDialogElement;
  private form: HTMLFormElement;
  private titleInput: HTMLInputElement;
  private authorInput: HTMLInputElement;
  private subjectInput: HTMLInputElement;
  private keywordsInput: HTMLInputElement;
  private creatorInput: HTMLInputElement;
  private producerInput: HTMLInputElement;
  private pageCountEl: HTMLElement;
  private fileSizeEl: HTMLElement;
  private encryptionEl: HTMLElement;
  private fileNameEl: HTMLElement;
  private openFolderBtn: HTMLButtonElement;
  private sanitizePanel: HTMLElement;
  private sanitizeTriggerBtn: HTMLButtonElement;
  private saveBtn: HTMLButtonElement;
  private confirmSanitizeBtn: HTMLButtonElement;
  private cancelSanitizeBtn: HTMLButtonElement;
  private focusReturn: HTMLElement | null = null;
  private busy = false;
  private docVersion = editorState.documentVersion;

  constructor() {
    this.dialog = document.createElement("dialog");
    this.dialog.className = "doc-modal";
    this.dialog.setAttribute("aria-labelledby", "meta-modal-title");
    this.dialog.innerHTML = `
      <div class="doc-modal-header">
        <div class="doc-modal-title-wrap">
          ${icon(Info)}
          <h2 id="meta-modal-title">Document properties</h2>
        </div>
        <button type="button" class="ui-button ui-button--tool" data-close aria-label="Close document properties">
          ${icon(X)}
        </button>
      </div>
      <form id="meta-form" class="doc-modal-body">
        <div class="doc-meta-summary">
          <div class="doc-meta-stat">
            <span class="doc-meta-stat-label">Pages</span>
            <span class="doc-meta-stat-value" id="meta-stat-pages">0</span>
          </div>
          <div class="doc-meta-stat">
            <span class="doc-meta-stat-label">File size</span>
            <span class="doc-meta-stat-value" id="meta-stat-size">0 B</span>
          </div>
          <div class="doc-meta-stat">
            <span class="doc-meta-stat-label">Security</span>
            <span class="doc-meta-stat-value" id="meta-stat-security">
              <span class="ui-badge" id="meta-security-badge">Not encrypted</span>
            </span>
          </div>
        </div>
        <div class="doc-file-path-row">
          <p class="doc-hint doc-file-path-text" id="meta-file-name"></p>
          <button type="button" class="ui-button ui-button--outline ui-button--tool doc-reveal-folder-btn" id="meta-open-folder-btn" title="Open containing folder" aria-label="Open containing folder">
            ${icon(FolderOpen, 14)}
          </button>
        </div>

        <div class="doc-form-grid">
          <div class="doc-field doc-field--full">
            <label class="doc-label" for="meta-title">Title</label>
            <input class="ui-input" id="meta-title" type="text" placeholder="Document title" />
          </div>
          <div class="doc-field">
            <label class="doc-label" for="meta-author">Author</label>
            <input class="ui-input" id="meta-author" type="text" placeholder="Author name" />
          </div>
          <div class="doc-field">
            <label class="doc-label" for="meta-subject">Subject</label>
            <input class="ui-input" id="meta-subject" type="text" placeholder="Document subject" />
          </div>
          <div class="doc-field doc-field--full">
            <label class="doc-label" for="meta-keywords">Keywords</label>
            <input class="ui-input" id="meta-keywords" type="text" placeholder="Comma-separated keywords" />
          </div>
          <div class="doc-field">
            <label class="doc-label" for="meta-creator">Creator application</label>
            <input class="ui-input" id="meta-creator" type="text" placeholder="Creator" />
          </div>
          <div class="doc-field">
            <label class="doc-label" for="meta-producer">PDF producer</label>
            <input class="ui-input" id="meta-producer" type="text" placeholder="Producer" />
          </div>
        </div>

        <div class="ui-alert ui-alert--destructive doc-sanitize-confirm" id="meta-sanitize-confirm" hidden>
          <div class="flex items-start gap-2">
            ${icon(ShieldAlert)}
            <span>Remove all metadata fields (title, author, subject, keywords, creator, producer) and hidden XMP/document info?</span>
          </div>
          <div class="doc-sanitize-confirm-actions">
            <button type="button" class="ui-button ui-button--outline ui-button--sm" id="meta-sanitize-cancel">Cancel</button>
            <button type="button" class="ui-button ui-button--destructive ui-button--sm" id="meta-sanitize-confirm-btn">Strip all metadata</button>
          </div>
        </div>
      </form>
      <div class="doc-modal-footer">
        <button type="button" class="ui-button ui-button--destructive" id="meta-sanitize-trigger">
          Strip metadata
        </button>
        <div class="doc-modal-footer-actions">
          <button type="button" class="ui-button ui-button--outline" data-close>Cancel</button>
          <button type="submit" form="meta-form" class="ui-button ui-button--default" id="meta-save-btn">Save properties</button>
        </div>
      </div>
    `;

    document.body.appendChild(this.dialog);

    this.form = this.dialog.querySelector("#meta-form")!;
    this.titleInput = this.dialog.querySelector("#meta-title")!;
    this.authorInput = this.dialog.querySelector("#meta-author")!;
    this.subjectInput = this.dialog.querySelector("#meta-subject")!;
    this.keywordsInput = this.dialog.querySelector("#meta-keywords")!;
    this.creatorInput = this.dialog.querySelector("#meta-creator")!;
    this.producerInput = this.dialog.querySelector("#meta-producer")!;
    this.pageCountEl = this.dialog.querySelector("#meta-stat-pages")!;
    this.fileSizeEl = this.dialog.querySelector("#meta-stat-size")!;
    this.encryptionEl = this.dialog.querySelector("#meta-security-badge")!;
    this.fileNameEl = this.dialog.querySelector("#meta-file-name")!;
    this.openFolderBtn = this.dialog.querySelector("#meta-open-folder-btn")!;
    this.sanitizePanel = this.dialog.querySelector("#meta-sanitize-confirm")!;
    this.sanitizeTriggerBtn = this.dialog.querySelector("#meta-sanitize-trigger")!;
    this.saveBtn = this.dialog.querySelector("#meta-save-btn")!;
    this.confirmSanitizeBtn = this.dialog.querySelector("#meta-sanitize-confirm-btn")!;
    this.cancelSanitizeBtn = this.dialog.querySelector("#meta-sanitize-cancel")!;

    this.bindEvents();
  }

  private bindEvents() {
    window.addEventListener("open-metadata", () => this.open());

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

    this.sanitizeTriggerBtn.addEventListener("click", () => {
      this.sanitizePanel.hidden = false;
      this.confirmSanitizeBtn.focus();
    });

    this.cancelSanitizeBtn.addEventListener("click", () => {
      this.sanitizePanel.hidden = true;
      this.sanitizeTriggerBtn.focus();
    });

    this.confirmSanitizeBtn.addEventListener("click", () => void this.handleStripMetadata());

    this.openFolderBtn.addEventListener("click", () => {
      const path = editorState.doc?.file_path;
      if (!path) return;
      void Backend.revealInFolder(path).catch((err) => {
        toast.show({ message: `Could not open folder: ${String(err)}`, type: "error" });
      });
    });

    this.form.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.handleSave();
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
    this.populate();
    this.sanitizePanel.hidden = true;
    if (!this.dialog.open) this.dialog.showModal();
    this.titleInput.focus();
  }

  close() {
    if (this.dialog.open) this.dialog.close();
  }

  private populate() {
    const doc = editorState.doc;
    if (!doc) return;
    const meta = doc.metadata;

    this.pageCountEl.textContent = String(meta.page_count);
    this.fileSizeEl.textContent = formatFileSize(meta.file_size_bytes);
    this.fileSizeEl.title = `${meta.file_size_bytes.toLocaleString()} bytes`;
    this.encryptionEl.textContent = meta.is_encrypted ? "Encrypted" : "Not encrypted";
    this.encryptionEl.className = meta.is_encrypted ? "ui-badge ui-badge--accent" : "ui-badge";
    this.fileNameEl.textContent = doc.file_path ? `File: ${doc.file_path}` : `File: ${doc.file_name} (unsaved)`;
    this.openFolderBtn.hidden = !doc.file_path;
    this.openFolderBtn.disabled = !doc.file_path;

    this.titleInput.value = meta.title ?? "";
    this.authorInput.value = meta.author ?? "";
    this.subjectInput.value = meta.subject ?? "";
    this.keywordsInput.value = meta.keywords ?? "";
    this.creatorInput.value = meta.creator ?? "";
    this.producerInput.value = meta.producer ?? "";
  }

  private setBusy(busy: boolean, label?: string) {
    this.busy = busy;
    this.saveBtn.disabled = busy;
    this.sanitizeTriggerBtn.disabled = busy;
    this.confirmSanitizeBtn.disabled = busy;
    this.cancelSanitizeBtn.disabled = busy;
    this.saveBtn.textContent = busy && label ? label : "Save properties";
  }

  private async handleSave() {
    if (this.busy || !editorState.doc) return;
    const update: DocumentMetadataUpdate = {
      title: normalizeMetadataField(this.titleInput.value),
      author: normalizeMetadataField(this.authorInput.value),
      subject: normalizeMetadataField(this.subjectInput.value),
      keywords: normalizeMetadataField(this.keywordsInput.value),
      creator: normalizeMetadataField(this.creatorInput.value),
      producer: normalizeMetadataField(this.producerInput.value),
    };

    this.setBusy(true, "Saving...");
    try {
      const updated = await Backend.updateMetadata(update);
      editorState.updateDocument(updated);
      toast.show({ message: "Document properties updated.", type: "success" });
      this.close();
    } catch (err) {
      toast.show({ message: `Could not update properties: ${String(err)}`, type: "error" });
    } finally {
      this.setBusy(false);
    }
  }

  private async handleStripMetadata() {
    if (this.busy || !editorState.doc) return;
    this.setBusy(true, "Sanitizing...");
    try {
      const updated = await Backend.stripMetadata();
      editorState.updateDocument(updated);
      this.populate();
      this.sanitizePanel.hidden = true;
      toast.show({ message: "All document metadata stripped.", type: "success" });
    } catch (err) {
      toast.show({ message: `Could not strip metadata: ${String(err)}`, type: "error" });
    } finally {
      this.setBusy(false);
    }
  }
}

let metadataModalInstance: MetadataModalView | null = null;

export function initMetadataModal(): MetadataModalView {
  if (!metadataModalInstance) {
    metadataModalInstance = new MetadataModalView();
  }
  return metadataModalInstance;
}

export function initDocToolModals(): void {
  initMetadataModal();
  initMergeSplitModal();
  initExportPrintModal();
  initInsertPageModal();
  initWatermarkModal();
}

if (typeof document !== "undefined") {
  initMetadataModal();
}

