import { STRINGS } from "../i18n/strings";
import { Backend } from "../ipc/backend";
import { editorState } from "../state/editorState";
import { toast } from "./Toast";

export class EmptyStateView {
  private element: HTMLElement;

  constructor(element: HTMLElement) {
    this.element = element;
    this.render();
    editorState.subscribe(() => this.render());
  }

  private render() {
    if (editorState.doc !== null) {
      this.element.style.display = "none";
      return;
    }

    this.element.style.display = "flex";
    this.element.className = "empty-state-overlay";

    const recentHtml =
      editorState.recentFiles.length > 0
        ? editorState.recentFiles
            .map((p) => {
              const fileName = p.split(/[\\/]/).pop() || p;
              const dirPath = p.substring(0, p.length - fileName.length).replace(/[\\/]$/, "");
              return `
              <button class="recent-doc-card" data-path="${p}" title="${p}">
                <div class="recent-doc-badge">PDF</div>
                <div class="recent-doc-info">
                  <span class="recent-doc-name">${fileName}</span>
                  <span class="recent-doc-path">${dirPath || p}</span>
                </div>
                <div class="recent-doc-arrow">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>
                </div>
              </button>`;
            })
            .join("")
        : `<div class="text-muted small py-3 text-center">${STRINGS.emptyState.noRecent}</div>`;

    this.element.innerHTML = `
      <div class="empty-state-card" id="drop-target-card">
        <div class="empty-icon-badge">
          <svg class="empty-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <polyline points="14 2 14 8 20 8"></polyline>
            <line x1="12" y1="18" x2="12" y2="12"></line>
            <line x1="9" y1="15" x2="15" y2="15"></line>
          </svg>
        </div>
        
        <div class="text-center">
          <h3 class="fw-bold mb-2 tracking-tight">${STRINGS.emptyState.headline}</h3>
          <p class="text-muted small mb-0">${STRINGS.emptyState.subheadline}</p>
        </div>
        
        <div class="d-flex gap-3 justify-content-center mt-1">
          <button class="btn btn-primary px-4 py-2 d-flex align-items-center gap-2 shadow-sm" id="empty-open-btn">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
            <span>${STRINGS.emptyState.browseButton}</span>
          </button>
          <button class="btn btn-outline-secondary px-3 py-2 d-flex align-items-center gap-2" id="empty-new-btn">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
            <span>New Blank</span>
          </button>
        </div>
        
        <div class="w-100 text-start mt-3">
          <div class="d-flex justify-content-between align-items-center mb-2 px-1">
            <span class="small fw-semibold text-muted text-uppercase" style="letter-spacing: 0.5px; font-size: 11px;">${STRINGS.emptyState.recentFiles}</span>
            ${editorState.recentFiles.length > 0 ? `<span class="badge bg-secondary-subtle text-secondary small">${editorState.recentFiles.length}</span>` : ""}
          </div>
          <div class="recent-docs-container" id="recent-files-list">
            ${recentHtml}
          </div>
        </div>
        
        <div class="text-muted small mt-1 d-flex align-items-center gap-1">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 10l5 5 5-5"></path><path d="M12 15V3"></path></svg>
          <span>${STRINGS.emptyState.dragHint}</span>
        </div>
      </div>
    `;

    this.bindEvents();
  }

  private bindEvents() {
    const card = this.element.querySelector("#drop-target-card");
    const openBtn = this.element.querySelector("#empty-open-btn");
    const newBtn = this.element.querySelector("#empty-new-btn");
    const recentList = this.element.querySelector("#recent-files-list");

    openBtn?.addEventListener("click", () => this.handleOpenDialog());
    newBtn?.addEventListener("click", async () => {
      try {
        const doc = await Backend.newDocument();
        editorState.setDocument(doc);
      } catch (err: any) {
        toast.show({ message: err.toString(), type: "error" });
      }
    });

    recentList?.addEventListener("click", (e) => {
      const target = (e.target as HTMLElement).closest("button[data-path]") as HTMLButtonElement | null;
      if (target) {
        const path = target.getAttribute("data-path");
        if (path) this.loadFilePath(path);
      }
    });

    // Native Drag and Drop onto empty card
    card?.addEventListener("dragover", (e) => {
      e.preventDefault();
      card.classList.add("drag-over");
    });

    card?.addEventListener("dragleave", () => {
      card.classList.remove("drag-over");
    });

    card?.addEventListener("drop", (e: any) => {
      e.preventDefault();
      card.classList.remove("drag-over");
      if (e.dataTransfer?.files?.length) {
        const file = e.dataTransfer.files[0];
        if (!file.name.toLowerCase().endsWith(".pdf")) {
          toast.show({
            message: "Unsupported file format. Please drop a valid .pdf file.",
            type: "error",
          });
          return;
        }
        // In webview context, file.path is available
        const path = (file as any).path || file.name;
        this.loadFilePath(path);
      }
    });
  }

  async handleOpenDialog() {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        multiple: false,
        filters: [{ name: "PDF Files", extensions: ["pdf"] }],
      });
      if (selected && typeof selected === "string") {
        this.loadFilePath(selected);
      }
    } catch {
      // Fallback HTML file picker if outside Tauri
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".pdf";
      input.onchange = (e: any) => {
        const file = e.target.files?.[0];
        if (file) {
          const path = file.path || file.name;
          this.loadFilePath(path);
        }
      };
      input.click();
    }
  }

  async loadFilePath(path: string) {
    if (!path.toLowerCase().endsWith(".pdf")) {
      toast.show({
        message: "The chosen file is not a PDF document.",
        type: "error",
      });
      return;
    }

    try {
      const doc = await Backend.openDocument(path);
      editorState.setDocument(doc);
      toast.show({
        message: `Opened '${doc.file_name}' (${doc.page_count} pages)`,
        type: "success",
      });
    } catch (err: any) {
      toast.show({
        message: `Failed to open document: ${err.message || err}`,
        type: "error",
      });
    }
  }
}
