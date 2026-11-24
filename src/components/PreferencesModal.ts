import { RotateCcw, Settings, Trash2, X } from "lucide";
import { STRINGS } from "../i18n/strings";
import { editorState } from "../state/editorState";
import { DefaultZoomMode, MeasurementUnit, ThemeMode, ViewMode } from "../types/editor";
import { toast } from "./Toast";
import { icon } from "./ui/icon";

export class PreferencesModalView {
  private dialog: HTMLDialogElement;
  private focusReturn: HTMLElement | null = null;

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

    window.addEventListener("open-preferences", () => this.open());
  }

  open() {
    if (this.dialog.open) return;
    this.focusReturn = document.activeElement instanceof HTMLElement ? document.activeElement : null;
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

        <div class="editor-modal-body">
          <section class="prefs-section">
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
          </section>

          <section class="prefs-section">
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

    this.dialog.querySelector<HTMLSelectElement>("#prefs-units")?.addEventListener("change", (e) => {
      editorState.updatePreferences({ units: (e.target as HTMLSelectElement).value as MeasurementUnit });
    });

    authorInput.addEventListener("change", () => {
      const val = authorInput.value.trim() || "User";
      authorInput.value = val;
      editorState.updatePreferences({ author: val });
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

    this.dialog.querySelector("#prefs-reset-btn")?.addEventListener("click", () => {
      editorState.resetPreferences();
      toast.show({ message: "Preferences reset to defaults.", type: "info" });
      this.render();
    });
  }
}
