import { ChevronRight, FileText, FolderOpen, Plus } from "lucide";
import { icon } from "./ui/icon";
import { STRINGS } from "../i18n/strings";
import { editorState } from "../state/editorState";
import { guardedNewDocument, guardedOpenPdf, guardedPickPdf } from "./UnsavedGuard";

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

    this.element.innerHTML = `
      <section class="welcome" id="drop-target-card" aria-labelledby="welcome-title">
        <h1 id="welcome-title">${STRINGS.emptyState.headline}</h1>
        <p class="welcome-hint">${STRINGS.emptyState.dragHint}</p>
        <div class="welcome-actions">
          <button class="ui-button ui-button--default" id="empty-open-btn">
            ${icon(FolderOpen)} <span>${STRINGS.emptyState.browseButton}</span>
          </button>
          <button class="ui-button ui-button--outline" id="empty-new-btn">
            ${icon(Plus)} <span>${STRINGS.emptyState.newButton}</span>
          </button>
        </div>
        <section class="welcome-recent" aria-labelledby="recent-title">
          <h2 id="recent-title">${STRINGS.emptyState.recentFiles}</h2>
          <ul class="recent-docs-container" id="recent-files-list"></ul>
        </section>
      </section>
    `;

    const list = this.element.querySelector("#recent-files-list")!;
    if (!editorState.recentFiles.length) {
      const empty = document.createElement("li");
      empty.className = "text-muted-foreground";
      empty.textContent = STRINGS.emptyState.noRecent;
      list.appendChild(empty);
    }
    for (const path of editorState.recentFiles) {
      const name = path.split(/[\\/]/).pop() || path;
      const directory = path.slice(0, -name.length).replace(/[\\/]$/, "");
      const item = document.createElement("li");
      item.innerHTML = `
        <button type="button" class="recent-doc-card">
          ${icon(FileText, 20)}
          <span class="recent-doc-info">
            <span class="recent-doc-name"></span>
            <span class="recent-doc-path"></span>
          </span>
          ${icon(ChevronRight)}
        </button>
      `;
      const button = item.querySelector("button")!;
      button.dataset.path = path;
      button.title = path;
      item.querySelector(".recent-doc-name")!.textContent = name;
      item.querySelector(".recent-doc-path")!.textContent = directory || path;
      list.appendChild(item);
    }

    this.bindEvents();
  }

  private bindEvents() {
    const card = this.element.querySelector("#drop-target-card");
    const openBtn = this.element.querySelector("#empty-open-btn");
    const newBtn = this.element.querySelector("#empty-new-btn");
    const recentList = this.element.querySelector("#recent-files-list");

    openBtn?.addEventListener("click", () => {
      void guardedPickPdf();
    });
    newBtn?.addEventListener("click", () => {
      void guardedNewDocument();
    });

    recentList?.addEventListener("click", (e) => {
      const target = (e.target as HTMLElement).closest("button[data-path]") as HTMLButtonElement | null;
      if (target) {
        const path = target.getAttribute("data-path");
        if (path) void guardedOpenPdf(path);
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

    card?.addEventListener("drop", () => card.classList.remove("drag-over"));
  }
}
