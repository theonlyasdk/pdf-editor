import {
  AlertTriangle,
  ArrowUpCircle,
  BookOpen,
  CheckCircle2,
  ExternalLink,
  Grid2X2,
  Palette,
  RefreshCw,
  RotateCcw,
  Save,
  Settings,
  Trash2,
  X,
} from "lucide";
import { STRINGS } from "../i18n/strings";
import { Backend } from "../ipc/backend";
import {
  APP_VERSION,
  checkForUpdates,
  formatLastChecked,
  loadLastUpdateCheck,
  UpdateCheckResult,
} from "../services/updateChecker";
import { editorState } from "../state/editorState";
import { DefaultZoomMode, MeasurementUnit, ThemeMode, ViewMode } from "../types/editor";
import { toast } from "./Toast";
import { icon } from "./ui/icon";
import { animateDialogSize, initSlidingTabs } from "./ui/modalMotion";

type PrefsTab = "appearance" | "editing" | "grid" | "saving" | "updates";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export class PreferencesModalView {
  private dialog: HTMLDialogElement;
  private focusReturn: HTMLElement | null = null;
  private activeTab: PrefsTab = "appearance";
  private isCheckingUpdates = false;
  private lastUpdateCheck: UpdateCheckResult | null = null;

  constructor() {
    this.dialog = document.createElement("dialog");
    this.dialog.className = "editor-modal preferences-modal";
    this.dialog.setAttribute("aria-labelledby", "prefs-modal-title");
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

    window.addEventListener("open-preferences", (e) => {
      const detail = e instanceof CustomEvent ? (e.detail as { tab?: PrefsTab } | undefined) : undefined;
      if (detail?.tab) {
        this.activeTab = detail.tab;
      }
      this.open();
    });
  }

  open() {
    if (this.dialog.open) return;
    this.focusReturn = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.lastUpdateCheck = loadLastUpdateCheck();
    this.render();
    this.dialog.showModal();
    this.dialog.querySelector<HTMLElement>("select, input, button")?.focus();
  }

  close() {
    if (this.dialog.open) this.dialog.close();
  }

  private render() {
    const prefs = editorState.preferences;
    const recentCount = editorState.recentFiles.length;

    this.dialog.innerHTML = `
      <div class="editor-modal-card">
        <header class="editor-modal-header">
          <div class="editor-modal-title-wrap">
            ${icon(Settings, 18)}
            <h2 id="prefs-modal-title">${STRINGS.preferences.title}</h2>
          </div>
          <button type="button" class="ui-button ui-button--tool" id="prefs-close-btn" aria-label="Close">
            ${icon(X)}
          </button>
        </header>

        <div class="editor-modal-body prefs-layout">
          <nav class="prefs-sidebar" role="tablist" aria-label="Preference categories" aria-orientation="vertical">
            <button type="button" class="prefs-tab-btn ${this.activeTab === "appearance" ? "active" : ""}" role="tab" aria-selected="${this.activeTab === "appearance"}" data-prefs-tab-btn="appearance">
              ${icon(Palette, 15)}
              <span>Appearance</span>
            </button>
            <button type="button" class="prefs-tab-btn ${this.activeTab === "editing" ? "active" : ""}" role="tab" aria-selected="${this.activeTab === "editing"}" data-prefs-tab-btn="editing">
              ${icon(BookOpen, 15)}
              <span>Reading &amp; Editing</span>
            </button>
            <button type="button" class="prefs-tab-btn ${this.activeTab === "grid" ? "active" : ""}" role="tab" aria-selected="${this.activeTab === "grid"}" data-prefs-tab-btn="grid">
              ${icon(Grid2X2, 15)}
              <span>Grid &amp; Memory</span>
            </button>
            <button type="button" class="prefs-tab-btn ${this.activeTab === "saving" ? "active" : ""}" role="tab" aria-selected="${this.activeTab === "saving"}" data-prefs-tab-btn="saving">
              ${icon(Save, 15)}
              <span>Saving &amp; Data</span>
            </button>
            <button type="button" class="prefs-tab-btn ${this.activeTab === "updates" ? "active" : ""}" role="tab" aria-selected="${this.activeTab === "updates"}" data-prefs-tab-btn="updates">
              ${icon(RefreshCw, 15)}
              <span>Updates</span>
            </button>
          </nav>

          <div class="prefs-content">
          <section class="prefs-section" data-prefs-panel="appearance" ${this.activeTab === "appearance" ? "" : "hidden"}>
            <h3 class="prefs-section-title">${STRINGS.preferences.appearance}</h3>

            <div class="prefs-row">
              <label class="prefs-label" for="prefs-theme-mode">${STRINGS.preferences.themeMode}</label>
              <select class="ui-input" id="prefs-theme-mode">
                <option value="system" ${prefs.themeMode === "system" ? "selected" : ""}>${STRINGS.preferences.themeSystem}</option>
                <option value="light" ${prefs.themeMode === "light" ? "selected" : ""}>${STRINGS.preferences.themeLight}</option>
                <option value="dark" ${prefs.themeMode === "dark" ? "selected" : ""}>${STRINGS.preferences.themeDark}</option>
              </select>
            </div>

            <div class="prefs-row">
              <label class="prefs-label" for="prefs-default-view">${STRINGS.preferences.defaultViewMode}</label>
              <select class="ui-input" id="prefs-default-view">
                <option value="continuous" ${prefs.defaultViewMode === "continuous" ? "selected" : ""}>${STRINGS.viewModes.continuous}</option>
                <option value="single" ${prefs.defaultViewMode === "single" ? "selected" : ""}>${STRINGS.viewModes.single}</option>
                <option value="spread" ${prefs.defaultViewMode === "spread" ? "selected" : ""}>${STRINGS.viewModes.spread}</option>
                <option value="grid" ${prefs.defaultViewMode === "grid" ? "selected" : ""}>${STRINGS.viewModes.grid}</option>
              </select>
            </div>

            <div class="prefs-row">
              <label class="prefs-label" for="prefs-default-zoom">${STRINGS.preferences.defaultZoom}</label>
              <select class="ui-input" id="prefs-default-zoom">
                <option value="100%" ${prefs.defaultZoom === "100%" ? "selected" : ""}>100% (Actual size)</option>
                <option value="fit-width" ${prefs.defaultZoom === "fit-width" ? "selected" : ""}>${STRINGS.viewModes.fitWidth}</option>
                <option value="fit-page" ${prefs.defaultZoom === "fit-page" ? "selected" : ""}>${STRINGS.viewModes.fitPage}</option>
              </select>
            </div>

            <label class="ui-check prefs-check">
              <input type="checkbox" id="prefs-smooth-zoom" ${prefs.smoothZoom ? "checked" : ""} />
              <span>${STRINGS.preferences.smoothZoom}</span>
            </label>

            <label class="ui-check prefs-check">
              <input type="checkbox" id="prefs-animate-view-transitions" ${prefs.animateViewTransitions ? "checked" : ""} />
              <span>${STRINGS.preferences.animateViewTransitions}</span>
            </label>

            <label class="ui-check prefs-check">
              <input type="checkbox" id="prefs-grid-radial-fly" ${prefs.gridRadialFlyIn ? "checked" : ""} />
              <span>${STRINGS.preferences.gridRadialFlyIn}</span>
            </label>

            <label class="ui-check prefs-check">
              <input type="checkbox" id="prefs-reopen-last-pdf" ${prefs.reopenLastPdf ? "checked" : ""} />
              <span>${STRINGS.preferences.reopenLastPdf}</span>
            </label>
          </section>

          <section class="prefs-section" data-prefs-panel="editing" ${this.activeTab === "editing" ? "" : "hidden"}>
            <h3 class="prefs-section-title">Reading &amp; Editing</h3>

            <div class="prefs-row">
              <label class="prefs-label" for="prefs-default-tool">Default tool on open</label>
              <select class="ui-input" id="prefs-default-tool">
                <option value="select" ${(prefs.defaultTool ?? "select") === "select" ? "selected" : ""}>Select &amp; Text</option>
                <option value="hand" ${prefs.defaultTool === "hand" ? "selected" : ""}>Hand / Pan</option>
              </select>
            </div>

            <div class="prefs-row">
              <label class="prefs-label" for="prefs-units">${STRINGS.preferences.units}</label>
              <select class="ui-input" id="prefs-units">
                <option value="pt" ${prefs.units === "pt" ? "selected" : ""}>${STRINGS.crop.unitPt}</option>
                <option value="mm" ${prefs.units === "mm" ? "selected" : ""}>${STRINGS.crop.unitMm}</option>
                <option value="in" ${prefs.units === "in" ? "selected" : ""}>${STRINGS.crop.unitIn}</option>
              </select>
            </div>

            <div class="prefs-row">
              <label class="prefs-label" for="prefs-author">${STRINGS.preferences.author}</label>
              <input type="text" class="ui-input" id="prefs-author" placeholder="User" />
            </div>

            <label class="ui-check prefs-check">
              <input type="checkbox" id="prefs-show-links" ${prefs.showLinks !== false ? "checked" : ""} />
              <span>Enable clickable PDF links</span>
            </label>

            <label class="ui-check prefs-check">
              <input type="checkbox" id="prefs-show-forms" ${prefs.showForms !== false ? "checked" : ""} />
              <span>Enable interactive form fields (AcroForms)</span>
            </label>
          </section>

          <section class="prefs-section" data-prefs-panel="grid" ${this.activeTab === "grid" ? "" : "hidden"}>
            <h3 class="prefs-section-title">${STRINGS.preferences.gridAndMemory}</h3>

            <div class="prefs-row">
              <label class="prefs-label" for="prefs-grid-columns">${STRINGS.preferences.gridColumns}</label>
              <select class="ui-input" id="prefs-grid-columns">
                ${[2, 3, 4, 5, 6, 8, 10, 12]
                  .map(
                    (cols) =>
                      `<option value="${cols}" ${prefs.gridColumns === cols ? "selected" : ""}>${cols} columns${cols === 4 ? " (Default)" : ""}</option>`,
                  )
                  .join("")}
              </select>
            </div>

            <div class="prefs-row">
              <label class="prefs-label" for="prefs-zoom-sensitivity">Wheel zoom speed</label>
              <select class="ui-input" id="prefs-zoom-sensitivity">
                <option value="0.6" ${(prefs.zoomSensitivity ?? 1) === 0.6 ? "selected" : ""}>Slow (0.6×)</option>
                <option value="1" ${(prefs.zoomSensitivity ?? 1) === 1 ? "selected" : ""}>Normal (1×)</option>
                <option value="1.5" ${(prefs.zoomSensitivity ?? 1) === 1.5 ? "selected" : ""}>Fast (1.5×)</option>
              </select>
            </div>

            <label class="ui-check prefs-check">
              <input type="checkbox" id="prefs-cache-all-pages" ${prefs.cacheAllPages ? "checked" : ""} />
              <span>${STRINGS.preferences.cacheAllPages}</span>
            </label>

            <div class="ui-alert ui-alert--warning prefs-warning" id="prefs-cache-warning" role="alert" ${prefs.cacheAllPages ? "" : "hidden"}>
              ${icon(AlertTriangle, 16)}
              <span>${STRINGS.preferences.cacheAllPagesWarning}</span>
            </div>
          </section>

          <section class="prefs-section" data-prefs-panel="saving" ${this.activeTab === "saving" ? "" : "hidden"}>
            <h3 class="prefs-section-title">${STRINGS.preferences.saving}</h3>

            <label class="ui-check prefs-check">
              <input type="checkbox" id="prefs-make-backup" ${prefs.makeBackup ? "checked" : ""} />
              <span>${STRINGS.preferences.makeBackup}</span>
            </label>

            <div class="prefs-row">
              <label class="prefs-label" for="prefs-autosave">${STRINGS.preferences.autosaveInterval}</label>
              <select class="ui-input" id="prefs-autosave">
                <option value="0" ${prefs.autosaveIntervalSec === 0 ? "selected" : ""}>${STRINGS.preferences.autosaveOff}</option>
                <option value="30" ${prefs.autosaveIntervalSec === 30 ? "selected" : ""}>Every 30 seconds</option>
                <option value="60" ${prefs.autosaveIntervalSec === 60 ? "selected" : ""}>Every 1 minute</option>
                <option value="120" ${prefs.autosaveIntervalSec === 120 ? "selected" : ""}>Every 2 minutes</option>
                <option value="300" ${prefs.autosaveIntervalSec === 300 ? "selected" : ""}>Every 5 minutes</option>
              </select>
            </div>

            <div class="prefs-row prefs-row--actions">
              <span class="prefs-label">Recent documents (${recentCount})</span>
              <button type="button" class="ui-button ui-button--outline ui-button--sm" id="prefs-clear-recent" ${recentCount === 0 ? "disabled" : ""}>
                ${icon(Trash2, 14)}
                <span>${STRINGS.preferences.clearRecent}</span>
              </button>
            </div>
          </section>

          <section class="prefs-section" data-prefs-panel="updates" ${this.activeTab === "updates" ? "" : "hidden"}>
            <h3 class="prefs-section-title">${STRINGS.preferences.updates}</h3>

            <label class="ui-check prefs-check">
              <input type="checkbox" id="prefs-auto-check-updates" ${prefs.autoCheckUpdates ? "checked" : ""} />
              <span>${STRINGS.preferences.autoCheckUpdates}</span>
            </label>

            <div class="prefs-row prefs-row--actions">
              <div class="prefs-update-meta">
                <span class="prefs-label">Installed version: <strong>v${escapeHtml(APP_VERSION)}</strong></span>
                <span class="prefs-sublabel" id="prefs-update-last-checked">Last checked: ${escapeHtml(formatLastChecked(this.lastUpdateCheck?.checkedAt))}</span>
              </div>
              <button type="button" class="ui-button ui-button--outline ui-button--sm" id="prefs-check-updates" ${this.isCheckingUpdates ? "disabled" : ""}>
                ${icon(RefreshCw, 14)}
                <span>${this.isCheckingUpdates ? STRINGS.preferences.checkingUpdates : STRINGS.preferences.checkForUpdates}</span>
              </button>
            </div>

            <div id="prefs-update-status-container">${this.renderUpdateStatusHtml()}</div>
          </section>
          </div>
        </div>

        <footer class="editor-modal-footer">
          <button type="button" class="ui-button ui-button--outline" id="prefs-reset-btn">
            ${icon(RotateCcw, 15)}
            <span>${STRINGS.preferences.resetDefaults}</span>
          </button>
          <button type="button" class="ui-button ui-button--default" id="prefs-done-btn">
            <span>${STRINGS.preferences.done}</span>
          </button>
        </footer>
      </div>
    `;

    const authorInput = this.dialog.querySelector<HTMLInputElement>("#prefs-author")!;
    authorInput.value = prefs.author;

    this.dialog.querySelector("#prefs-close-btn")?.addEventListener("click", () => this.close());
    const sidebar = this.dialog.querySelector<HTMLElement>(".prefs-sidebar");
    const sliding = sidebar ? initSlidingTabs(sidebar, "[data-prefs-tab-btn]") : null;
    this.dialog.querySelectorAll<HTMLButtonElement>("[data-prefs-tab-btn]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tab = btn.dataset.prefsTabBtn as PrefsTab | undefined;
        if (!tab || tab === this.activeTab) return;
        this.activeTab = tab;
        const card = this.dialog.querySelector<HTMLElement>(".editor-modal-card");
        const apply = () => {
          this.dialog.querySelectorAll<HTMLButtonElement>("[data-prefs-tab-btn]").forEach((b) => {
            const active = b.dataset.prefsTabBtn === tab;
            b.classList.toggle("active", active);
            b.setAttribute("aria-selected", String(active));
          });
          this.dialog.querySelectorAll<HTMLElement>("[data-prefs-panel]").forEach((panel) => {
            panel.hidden = panel.dataset.prefsPanel !== tab;
          });
        };
        if (card) animateDialogSize(card, apply);
        else apply();
        sliding?.update();
      });
    });
    this.dialog.querySelector("#prefs-done-btn")?.addEventListener("click", () => this.close());

    this.dialog.querySelector<HTMLSelectElement>("#prefs-theme-mode")?.addEventListener("change", (e) => {
      editorState.updatePreferences({ themeMode: (e.target as HTMLSelectElement).value as ThemeMode });
    });

    this.dialog.querySelector<HTMLSelectElement>("#prefs-default-view")?.addEventListener("change", (e) => {
      const mode = (e.target as HTMLSelectElement).value as ViewMode;
      editorState.updatePreferences({ defaultViewMode: mode });
      if (editorState.doc) editorState.setViewMode(mode);
    });

    this.dialog.querySelector<HTMLSelectElement>("#prefs-default-zoom")?.addEventListener("change", (e) => {
      const defaultZoom = (e.target as HTMLSelectElement).value as DefaultZoomMode;
      editorState.updatePreferences({ defaultZoom });
      if (defaultZoom === "fit-width") editorState.requestFitWidth();
      else if (defaultZoom === "fit-page") editorState.requestFitPage();
      else editorState.setZoom(1.0);
    });

    this.dialog.querySelector<HTMLInputElement>("#prefs-smooth-zoom")?.addEventListener("change", (e) => {
      editorState.updatePreferences({ smoothZoom: (e.target as HTMLInputElement).checked });
    });

    this.dialog.querySelector<HTMLInputElement>("#prefs-animate-view-transitions")?.addEventListener("change", (e) => {
      editorState.updatePreferences({ animateViewTransitions: (e.target as HTMLInputElement).checked });
    });

    this.dialog.querySelector<HTMLInputElement>("#prefs-grid-radial-fly")?.addEventListener("change", (e) => {
      editorState.updatePreferences({ gridRadialFlyIn: (e.target as HTMLInputElement).checked });
    });

    this.dialog.querySelector<HTMLInputElement>("#prefs-reopen-last-pdf")?.addEventListener("change", (e) => {
      editorState.updatePreferences({ reopenLastPdf: (e.target as HTMLInputElement).checked });
    });

    this.dialog.querySelector<HTMLSelectElement>("#prefs-default-tool")?.addEventListener("change", (e) => {
      editorState.updatePreferences({ defaultTool: (e.target as HTMLSelectElement).value as "select" | "hand" });
    });

    this.dialog.querySelector<HTMLInputElement>("#prefs-show-links")?.addEventListener("change", (e) => {
      editorState.updatePreferences({ showLinks: (e.target as HTMLInputElement).checked });
    });

    this.dialog.querySelector<HTMLInputElement>("#prefs-show-forms")?.addEventListener("change", (e) => {
      editorState.updatePreferences({ showForms: (e.target as HTMLInputElement).checked });
    });

    this.dialog.querySelector<HTMLSelectElement>("#prefs-zoom-sensitivity")?.addEventListener("change", (e) => {
      editorState.updatePreferences({ zoomSensitivity: Number((e.target as HTMLSelectElement).value) || 1 });
    });

    this.dialog.querySelector<HTMLSelectElement>("#prefs-units")?.addEventListener("change", (e) => {
      editorState.updatePreferences({ units: (e.target as HTMLSelectElement).value as MeasurementUnit });
    });

    authorInput.addEventListener("change", () => {
      const val = authorInput.value.trim() || "User";
      authorInput.value = val;
      editorState.updatePreferences({ author: val });
    });

    this.dialog.querySelector<HTMLSelectElement>("#prefs-grid-columns")?.addEventListener("change", (e) => {
      editorState.updatePreferences({ gridColumns: Number((e.target as HTMLSelectElement).value) || 4 });
    });

    const cacheWarning = this.dialog.querySelector<HTMLElement>("#prefs-cache-warning");
    this.dialog.querySelector<HTMLInputElement>("#prefs-cache-all-pages")?.addEventListener("change", (e) => {
      const checked = (e.target as HTMLInputElement).checked;
      if (cacheWarning) cacheWarning.hidden = !checked;
      editorState.updatePreferences({ cacheAllPages: checked });
      if (checked) {
        toast.show({
          message: "All-page memory caching enabled. Large PDFs may use heavy RAM or crash.",
          type: "warning",
          durationMs: 4500,
        });
      }
    });

    this.dialog.querySelector<HTMLInputElement>("#prefs-make-backup")?.addEventListener("change", (e) => {
      editorState.updatePreferences({ makeBackup: (e.target as HTMLInputElement).checked });
    });

    this.dialog.querySelector<HTMLSelectElement>("#prefs-autosave")?.addEventListener("change", (e) => {
      editorState.updatePreferences({ autosaveIntervalSec: Number((e.target as HTMLSelectElement).value) || 0 });
    });

    this.dialog.querySelector("#prefs-clear-recent")?.addEventListener("click", () => {
      editorState.clearRecentFiles();
      toast.show({ message: "Cleared recent documents.", type: "info" });
      this.render();
    });

    this.dialog.querySelector<HTMLInputElement>("#prefs-auto-check-updates")?.addEventListener("change", (e) => {
      editorState.updatePreferences({ autoCheckUpdates: (e.target as HTMLInputElement).checked });
    });

    this.dialog.querySelector("#prefs-check-updates")?.addEventListener("click", () => {
      void this.handleManualUpdateCheck();
    });

    this.bindUpdateStatusActions();

    this.dialog.querySelector("#prefs-reset-btn")?.addEventListener("click", () => {
      editorState.resetPreferences();
      toast.show({ message: "Preferences reset to defaults.", type: "info" });
      this.render();
    });
  }

  private renderUpdateStatusHtml(): string {
    if (this.isCheckingUpdates) {
      return `
        <div class="ui-alert prefs-update-status" role="status">
          ${icon(RefreshCw, 16)}
          <span>Checking GitHub releases for updates…</span>
        </div>
      `;
    }

    const result = this.lastUpdateCheck;
    if (!result) return "";

    if (result.status === "update-available" && result.latestVersion) {
      return `
        <div class="ui-alert prefs-update-status prefs-update-status--available" role="status">
          ${icon(ArrowUpCircle, 16)}
          <div class="prefs-update-status-body">
            <div class="prefs-update-status-title">
              <span>Update available: <strong>v${escapeHtml(result.latestVersion)}</strong></span>
              <span class="ui-badge ui-badge--accent">New</span>
            </div>
            ${result.releaseName ? `<p class="prefs-sublabel">${escapeHtml(result.releaseName)}</p>` : ""}
          </div>
          <button type="button" class="ui-button ui-button--default ui-button--sm" id="prefs-open-release-btn">
            ${icon(ExternalLink, 14)}
            <span>${STRINGS.preferences.downloadUpdate}</span>
          </button>
        </div>
      `;
    }

    if (result.status === "up-to-date") {
      return `
        <div class="ui-alert prefs-update-status prefs-update-status--ok" role="status">
          ${icon(CheckCircle2, 16)}
          <span>You're up to date (v${escapeHtml(result.currentVersion)}).</span>
        </div>
      `;
    }

    return `
      <div class="ui-alert ui-alert--warning prefs-warning" role="alert">
        ${icon(AlertTriangle, 16)}
        <span>${escapeHtml(result.error || "Could not check for updates.")}</span>
      </div>
    `;
  }

  private refreshUpdateSection() {
    const checkBtn = this.dialog.querySelector<HTMLButtonElement>("#prefs-check-updates");
    if (checkBtn) {
      checkBtn.disabled = this.isCheckingUpdates;
      const label = checkBtn.querySelector("span");
      if (label) {
        label.textContent = this.isCheckingUpdates
          ? STRINGS.preferences.checkingUpdates
          : STRINGS.preferences.checkForUpdates;
      }
      checkBtn.classList.toggle("is-checking", this.isCheckingUpdates);
    }

    const lastCheckedEl = this.dialog.querySelector<HTMLElement>("#prefs-update-last-checked");
    if (lastCheckedEl) {
      lastCheckedEl.textContent = `Last checked: ${formatLastChecked(this.lastUpdateCheck?.checkedAt)}`;
    }

    const statusContainer = this.dialog.querySelector<HTMLElement>("#prefs-update-status-container");
    if (statusContainer) {
      statusContainer.innerHTML = this.renderUpdateStatusHtml();
      this.bindUpdateStatusActions();
    }
  }

  private bindUpdateStatusActions() {
    this.dialog.querySelector("#prefs-open-release-btn")?.addEventListener("click", () => {
      if (this.lastUpdateCheck?.releaseUrl) {
        void Backend.openExternalUrl(this.lastUpdateCheck.releaseUrl);
      }
    });
  }

  private async handleManualUpdateCheck() {
    if (this.isCheckingUpdates) return;
    this.isCheckingUpdates = true;
    this.refreshUpdateSection();

    try {
      this.lastUpdateCheck = await checkForUpdates();
    } finally {
      this.isCheckingUpdates = false;
      if (this.dialog.open) {
        this.refreshUpdateSection();
      }
    }
  }
}
