import { Backend } from "../ipc/backend";
import { editorState } from "../state/editorState";
import type { PageBox } from "../types/editor";
import { rasterizeImageBlob, rasterizeImageDataUrl } from "./SignatureModal";
import { toast } from "./Toast";

const IMAGE_EXT_RE = /\.(png|jpe?g)$/i;

export function isSupportedImagePath(path: string): boolean {
  return IMAGE_EXT_RE.test(path.trim());
}

export function isSupportedImageFile(file: File): boolean {
  if (file.type === "image/png" || file.type === "image/jpeg") return true;
  return IMAGE_EXT_RE.test(file.name);
}

/** Compute a bounded PDF-space placement rectangle centered at (centerX, centerY) or page center. */
export function computeImagePlacementRect(
  page: { width: number; height: number },
  imgWidth: number,
  imgHeight: number,
  centerX?: number,
  centerY?: number
): PageBox {
  const safeImgW = Math.max(1, imgWidth);
  const safeImgH = Math.max(1, imgHeight);
  const maxW = Math.max(48, page.width * 0.45);
  const maxH = Math.max(48, page.height * 0.45);
  const scale = Math.min(1, maxW / safeImgW, maxH / safeImgH);
  const w = Math.min(page.width, Math.max(24, safeImgW * scale));
  const h = Math.min(page.height, Math.max(24, safeImgH * scale));
  const cx = centerX ?? page.width / 2;
  const cy = centerY ?? page.height / 2;
  return {
    x: Math.max(0, Math.min(page.width - w, cx - w / 2)),
    y: Math.max(0, Math.min(page.height - h, cy - h / 2)),
    width: w,
    height: h,
  };
}

function resolveDropTarget(clientX?: number, clientY?: number): { pageIndex: number; centerX?: number; centerY?: number } {
  const doc = editorState.doc;
  if (!doc) return { pageIndex: 0 };

  if (typeof clientX === "number" && typeof clientY === "number" && typeof document.elementsFromPoint === "function") {
    const elements = document.elementsFromPoint(clientX, clientY);
    for (const el of elements) {
      const wrapper = (el as HTMLElement).closest?.(".pdf-page-wrapper") as HTMLElement | null;
      if (wrapper && wrapper.dataset.pageIndex !== undefined) {
        const pageIndex = Number(wrapper.dataset.pageIndex);
        const page = doc.pages[pageIndex];
        const rect = wrapper.getBoundingClientRect();
        if (page && rect.width > 0 && rect.height > 0) {
          const centerX = ((clientX - rect.left) / rect.width) * page.width;
          const centerY = ((clientY - rect.top) / rect.height) * page.height;
          return { pageIndex, centerX, centerY };
        }
      }
    }
  }

  return { pageIndex: Math.max(0, Math.min(doc.page_count - 1, editorState.currentPage)) };
}

export async function placeImageOnPageAtClientPoint(
  dataUrl: string,
  imgWidth: number,
  imgHeight: number,
  clientX?: number,
  clientY?: number,
  label = "image"
): Promise<void> {
  const doc = editorState.doc;
  if (!doc || editorState.openingFile) return;

  const { pageIndex, centerX, centerY } = resolveDropTarget(clientX, clientY);
  const page = doc.pages[pageIndex];
  if (!page) return;

  const rect = computeImagePlacementRect(page, imgWidth, imgHeight, centerX, centerY);
  const documentVersion = editorState.documentVersion;
  const updated = await Backend.addImageAnnotation(pageIndex, rect, dataUrl, 1.0);
  if (editorState.documentVersion === documentVersion) {
    editorState.updateDocument(updated);
    editorState.setTool("select");
    editorState.setCurrentPage(pageIndex);
  }
  const pageLabel = page.label || String(pageIndex + 1);
  toast.show({ message: `Added ${label} to page ${pageLabel}.`, type: "success" });
}

export async function handleDroppedImagePath(
  path: string,
  physicalX?: number,
  physicalY?: number
): Promise<void> {
  try {
    const rawUrl = await Backend.readImageDataUrl(path);
    const { dataUrl, width, height } = await rasterizeImageDataUrl(rawUrl, 1200, false);
    const dpr = window.devicePixelRatio || 1;
    const clientX = typeof physicalX === "number" ? physicalX / dpr : undefined;
    const clientY = typeof physicalY === "number" ? physicalY / dpr : undefined;
    const name = path.split(/[\\/]/).pop() || "image";
    await placeImageOnPageAtClientPoint(dataUrl, width, height, clientX, clientY, name);
  } catch (err) {
    toast.show({ message: `Could not add image: ${String(err)}`, type: "error" });
  }
}

export function initImagePasteHandler(): void {
  window.addEventListener("paste", async (e: ClipboardEvent) => {
    if (!editorState.doc || editorState.openingFile) return;
    const active = document.activeElement as HTMLElement | null;
    if (
      active &&
      (active.tagName === "INPUT" ||
        active.tagName === "TEXTAREA" ||
        active.tagName === "SELECT" ||
        active.isContentEditable)
    ) {
      return;
    }

    const dt = e.clipboardData;
    if (!dt) return;

    let imageBlob: Blob | null = null;
    if (dt.items) {
      for (const item of Array.from(dt.items)) {
        if (item.kind === "file" && (item.type === "image/png" || item.type === "image/jpeg" || item.type.startsWith("image/"))) {
          imageBlob = item.getAsFile();
          if (imageBlob) break;
        }
      }
    }
    if (!imageBlob && dt.files?.length) {
      const file = Array.from(dt.files).find((f) => isSupportedImageFile(f) || f.type.startsWith("image/"));
      if (file) imageBlob = file;
    }

    if (!imageBlob) return;
    e.preventDefault();
    try {
      const { dataUrl, width, height } = await rasterizeImageBlob(imageBlob, 1200);
      await placeImageOnPageAtClientPoint(dataUrl, width, height, undefined, undefined, "pasted image");
    } catch (err) {
      toast.show({ message: `Could not paste image: ${String(err)}`, type: "error" });
    }
  });
}
