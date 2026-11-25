import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AlertTriangle, X } from "lucide";
import { STRINGS } from "../i18n/strings";
import { Backend } from "../ipc/backend";
import { editorState } from "../state/editorState";
import { openPdf, pickPdf } from "./OpenPdf";
import { toast } from "./Toast";
import { icon } from "./ui/icon";

export type UnsavedDecision = "save" | "discard" | "cancel";

let activePrompt: Promise<boolean> | null = null;
let bypassWindowClose = false;

export async function saveCurrentOrSaveAs(): Promise<boolean> {
  const doc = editorState.doc;
  if (!doc) return true;
  try {
    if (doc.file_path) {
      await Backend.saveDocument(editorState.preferences.makeBackup);
      doc.is_dirty = false;
      editorState.notify();
      toast.show({ message: STRINGS.toasts.saved, type: "success" });
      return true;
    }
    const { save } = await import("@tauri-apps/plugin-dialog");
    const target = await save({
      filters: [{ name: "PDF Document", extensions: ["pdf"] }],
    });
    if (target && typeof target === "string") {
      await Backend.saveDocumentAs(target, editorState.preferences.makeBackup);
      const updated = await Backend.getDocumentState();
      editorState.updateDocument(updated);
      toast.show({ message: STRINGS.toasts.savedAs.replace("{path}", target), type: "success" });
      return true;
    }
    return false;
  } catch (err) {
    toast.show({ message: `Save failed: ${String(err)}`, type: "error" });
    return false;
  }
}

export function promptUnsavedDecision(fileName: string): Promise<UnsavedDecision> {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "editor-modal unsaved-modal";
    dialog.setAttribute("aria-labelledby", "unsaved-modal-title");
    dialog.innerHTML = `
      <div class="editor-modal-card">
        <header class="editor-modal-header">
          <div class="editor-modal-title-wrap">
            ${icon(AlertTriangle, 18)}
            <h2 id="unsaved-modal-title">${STRINGS.dialogs.unsavedTitle}</h2>
          </div>
          <button type="button" class="ui-button ui-button--tool" data-decision="cancel" aria-label="Close">
            ${icon(X)}
          </button>
        </header>
        <div class="editor-modal-body">
          <p class="unsaved-message"></p>
        </div>
        <footer class="editor-modal-footer">
          <button type="button" class="ui-button ui-button--outline" data-decision="discard">${STRINGS.dialogs.discard}</button>
          <div class="unsaved-footer-right">
            <button type="button" class="ui-button ui-button--outline" data-decision="cancel">${STRINGS.dialogs.cancel}</button>
            <button type="button" class="ui-button ui-button--default" data-decision="save">${STRINGS.dialogs.save}</button>
          </div>
        </footer>
      </div>
    `;
    dialog.querySelector(".unsaved-message")!.textContent = STRINGS.dialogs.unsavedChanges.replace("{name}", fileName);

    const focusReturn = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let settled = false;
    const finish = (decision: UnsavedDecision) => {
      if (settled) return;
      settled = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      if (focusReturn?.isConnected) focusReturn.focus({ preventScroll: true });
      resolve(decision);
    };

    dialog.addEventListener("cancel", (e) => {
      e.preventDefault();
      finish("cancel");
    });
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) finish("cancel");
    });
    dialog.querySelectorAll<HTMLButtonElement>("[data-decision]").forEach((btn) => {
      btn.addEventListener("click", () => {
        finish((btn.dataset.decision as UnsavedDecision) ?? "cancel");
      });
    });

    document.body.appendChild(dialog);
    dialog.showModal();
    dialog.querySelector<HTMLButtonElement>('[data-decision="save"]')?.focus();
  });
}

export async function confirmUnsavedChanges(): Promise<boolean> {
  if (!editorState.doc?.is_dirty) return true;
  if (activePrompt) return activePrompt;

  activePrompt = (async () => {
    const decision = await promptUnsavedDecision(editorState.doc?.file_name ?? STRINGS.app.untitled);
    if (decision === "discard") return true;
    if (decision === "save") return saveCurrentOrSaveAs();
    return false;
  })();

  try {
    return await activePrompt;
  } finally {
    activePrompt = null;
  }
}

export async function guardedOpenPdf(path: string): Promise<void> {
  if (!(await confirmUnsavedChanges())) return;
  await openPdf(path);
}

export async function guardedPickPdf(): Promise<void> {
  if (!(await confirmUnsavedChanges())) return;
  await pickPdf();
}

export async function guardedNewDocument(): Promise<void> {
  if (!(await confirmUnsavedChanges())) return;
  try {
    const doc = await Backend.newDocument();
    editorState.setDocument(doc);
  } catch (err) {
    toast.show({ message: String(err), type: "error" });
  }
}

export async function guardedCloseDocument(): Promise<void> {
  if (!editorState.doc) return;
  if (!(await confirmUnsavedChanges())) return;
  editorState.setDocument(null);
}

export function initWindowCloseGuard() {
  if (!isTauri()) {
    window.addEventListener("beforeunload", (event) => {
      if (editorState.doc?.is_dirty && !bypassWindowClose) {
        event.preventDefault();
        event.returnValue = "";
      }
    });
    return;
  }

  const win = getCurrentWindow();
  void win.onCloseRequested(async (event) => {
    if (bypassWindowClose || !editorState.doc?.is_dirty) return;
    event.preventDefault();
    const proceed = await confirmUnsavedChanges();
    if (proceed) {
      bypassWindowClose = true;
      try {
        await win.close();
      } catch {
        await win.destroy();
      }
    }
  });
}
