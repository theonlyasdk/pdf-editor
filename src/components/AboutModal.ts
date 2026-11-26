import { ExternalLink } from "lucide";
import { Backend } from "../ipc/backend";
import { icon } from "./ui/icon";

const SOURCE_REPO_URL = "https://github.com/theonlyasdk/pdf-editor";

const APP_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="56" height="56" aria-hidden="true">
  <defs>
    <linearGradient id="aboutBgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#1e293b"/>
      <stop offset="100%" stop-color="#0f172a"/>
    </linearGradient>
    <linearGradient id="aboutPdfGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ef4444"/>
      <stop offset="100%" stop-color="#b91c1c"/>
    </linearGradient>
  </defs>
  <rect x="32" y="32" width="448" height="448" rx="96" fill="url(#aboutBgGrad)" stroke="#334155" stroke-width="8"/>
  <path d="M 144 112 L 304 112 L 368 176 L 368 400 L 144 400 Z" fill="#ffffff"/>
  <path d="M 304 112 L 304 176 L 368 176 Z" fill="#cbd5e1"/>
  <rect x="176" y="240" width="160" height="64" rx="12" fill="url(#aboutPdfGrad)"/>
  <text x="256" y="284" font-family="system-ui, -apple-system, sans-serif" font-size="32" font-weight="900" fill="#ffffff" text-anchor="middle" letter-spacing="2">PDF</text>
  <circle cx="340" cy="350" r="32" fill="#2563eb" stroke="#ffffff" stroke-width="6"/>
  <path d="M 330 360 L 350 340 M 346 336 L 354 344" stroke="#ffffff" stroke-width="4" stroke-linecap="round"/>
</svg>`;

export class AboutModalView {
  private dialog: HTMLDialogElement;
  private focusReturn: HTMLElement | null = null;

  constructor() {
    this.dialog = document.createElement("dialog");
    this.dialog.className = "editor-modal about-modal";
    this.dialog.setAttribute("aria-labelledby", "about-project-name");
    this.dialog.innerHTML = `
      <div class="editor-modal-card">
        <div class="editor-modal-body about-modal-body">
          <div class="about-hero">
            <div class="about-app-icon">${APP_ICON_SVG}</div>
            <div class="about-hero-text">
              <h2 class="about-project-name" id="about-project-name">PDF Editor</h2>
              <p class="about-version">Version 0.4.0</p>
            </div>
          </div>

          <p class="about-credit">
            Created by <strong>theonlyasdk</strong>. Fast desktop PDF viewer, annotator, and page organizer.
          </p>
        </div>

        <footer class="editor-modal-footer about-modal-footer">
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
