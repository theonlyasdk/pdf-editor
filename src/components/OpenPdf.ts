import { Backend } from "../ipc/backend";
import { editorState } from "../state/editorState";
import { toast } from "./Toast";

export async function openPdf(path: string) {
  if (editorState.openingFile) return;
  if (!path.toLowerCase().endsWith(".pdf")) {
    toast.show({ message: "Choose a PDF file.", type: "error" });
    return;
  }

  editorState.setOpeningFile(path.split(/[\\/]/).pop() || path);
  try {
    editorState.setDocument(await Backend.openDocument(path));
  } catch (error) {
    toast.show({ message: `Could not open PDF: ${String(error)}`, type: "error" });
  } finally {
    editorState.setOpeningFile(null);
  }
}

export async function pickPdf() {
  if (editorState.openingFile) return;
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const path = await open({ filters: [{ name: "PDF Files", extensions: ["pdf"] }] });
    if (typeof path === "string") await openPdf(path);
  } catch (error) {
    toast.show({ message: `Could not open the file picker: ${String(error)}`, type: "error" });
  }
}
