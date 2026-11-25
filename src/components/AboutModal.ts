import { ExternalLink, FileText, X } from "lucide";
import { Backend } from "../ipc/backend";
import { icon } from "./ui/icon";

const SOURCE_REPO_URL = "https://github.com/theonlyasdk/pdf-editor";

export class AboutModalView {
  private dialog: HTMLDialogElement;
  private focusReturn: HTMLElement | null = null;

  constructor() {
    this.dialog = document.createElement("dialog");
    this.dialog.className = "editor-modal about-modal";
    this.dialog.setAttribute("aria-labelledby", "about-modal-title");
    this.dialog.innerHTML = `
      <div class="editor-modal-card">
        <header class="editor-modal-header">
          <div class="editor-modal-title-wrap">
            ${icon(FileText, 18)}
            <h2 id="about-modal-title">About</h2>
          </div>
          <button type="button" class="ui-button ui-button--tool" id="about-close-btn" aria-label="Close">
            ${icon(X)}
          </button>
        </header>

        <div class="editor-modal-body about-modal-body">
          <div class="about-hero">
            <div class="about-app-icon">${icon(FileText, 28)}</div>
            <div class="about-hero-text">
              <h3 class="about-project-name">PDF Editor</h3>
              <p class="about-version">Version 0.4.0</p>
            </div>
          </div>

          <p class="about-credit">
            Created by <strong>theonlyasdk</strong>. Fast desktop PDF viewer, annotator, and page organizer.
          </p>

          <div class="about-links">
            <a
              href="${SOURCE_REPO_URL}"
              target="_blank"
              rel="noopener noreferrer"
              class="ui-button ui-button--outline about-source-link"
              id="about-source-link"
            >
              ${icon(ExternalLink, 15)}
              <span>Source Code on GitHub</span>
            </a>
          </div>
        </div>

        <footer class="editor-modal-footer">
          <span class="about-repo-caption">${SOURCE_REPO_URL}</span>
          <button type="button" class="ui-button ui-button--default" id="about-done-btn">Close</button>
        </footer>
      </div>
    `;

    document.body.appendChild(this.dialog);

    this.dialog.addEventListener("click", (e) => {
      if (e.target === this.dialog) this.close();
    });

    this.dialog.addEventListener("close", () => {
      if (this.focusReturn?.isConnected) {
        this.focusReturn.focus({ preventScroll: true });
      }
      this.focusReturn = null;
    });

    this.dialog.querySelector("#about-close-btn")?.addEventListener("click", () => this.close());
    this.dialog.querySelector("#about-done-btn")?.addEventListener("click", () => this.close());

    this.dialog.querySelector("#about-source-link")?.addEventListener("click", (e) => {
      e.preventDefault();
      void Backend.openExternalUrl(SOURCE_REPO_URL);
    });

    window.addEventListener("open-about", () => this.open());
  }

  open() {
    if (this.dialog.open) return;
    this.focusReturn = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.dialog.showModal();
    this.dialog.querySelector<HTMLElement>("#about-source-link")?.focus();
  }

  close() {
    if (this.dialog.open) this.dialog.close();
  }
}
