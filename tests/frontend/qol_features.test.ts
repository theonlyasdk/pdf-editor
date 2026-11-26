import { describe, expect, it, beforeEach } from "vitest";
import { formatAnnotationsCsv, formatAnnotationsMarkdown } from "../../src/components/annotationExport";
import { computeImagePlacementRect, isSupportedImagePath } from "../../src/components/imageDropPaste";
import type { AnnotationDto, DocumentDto } from "../../src/types/editor";

function createMemoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
  };
}

describe("QoL features", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      value: createMemoryStorage(),
      configurable: true,
    });
  });

  it("recognizes supported image paths and bounds placement rects inside page", () => {
    expect(isSupportedImagePath("photo.png")).toBe(true);
    expect(isSupportedImagePath("C:\\tmp\\pic.JPEG")).toBe(true);
    expect(isSupportedImagePath("doc.pdf")).toBe(false);

    const rect = computeImagePlacementRect({ width: 600, height: 800 }, 1200, 600, 590, 790);
    expect(rect.width).toBeCloseTo(270);
    expect(rect.height).toBeCloseTo(135);
    expect(rect.x + rect.width).toBeLessThanOrEqual(600);
    expect(rect.y + rect.height).toBeLessThanOrEqual(800);
  });

  it("exports annotations as Markdown and CSV with logical page labels and escaping", () => {
    const annots: AnnotationDto[] = [
      {
        id: "a1",
        page_index: 0,
        annot_type: "stickyNote",
        rect: { x: 10, y: 10, width: 24, height: 24 },
        color: "#f59e0b",
        stroke_width: 1,
        opacity: 1,
        text: "Check \"quote\", please\nLine 2",
        author: "Alice",
        modified_date: "2026-11-26",
        locked: false,
      },
    ];

    const md = formatAnnotationsMarkdown(annots, "report.pdf", ["i"]);
    expect(md).toContain("# Annotations — report.pdf");
    expect(md).toContain("## Page i (p. 1)");
    expect(md).toContain("**Sticky Note** by Alice");
    expect(md).toContain("> Line 2");

    const csv = formatAnnotationsCsv(annots, ["i"]);
    expect(csv).toContain("page,page_label,type,author,modified_date,color,text");
    expect(csv).toContain('1,i,Sticky Note,Alice,2026-11-26,#f59e0b,"Check ""quote"", please\nLine 2"');
  });

  it("persists and restores session zoom, page, sidebar tab, and scroll position", async () => {
    const { editorState } = await import("../../src/state/editorState");
    const doc: DocumentDto = {
      file_path: "C:\\docs\\sample.pdf",
      file_name: "sample.pdf",
      page_count: 5,
      pages: Array.from({ length: 5 }, (_, index) => ({
        index,
        width: 612,
        height: 792,
        rotation: 0,
        media_box: { x: 0, y: 0, width: 612, height: 792 },
        label: index === 0 ? "i" : String(index),
      })),
      metadata: { page_count: 5, file_size_bytes: 1024, is_encrypted: false },
      can_undo: false,
      can_redo: false,
      is_dirty: false,
      revision_id: 1,
    };

    editorState.setDocument(doc);
    editorState.setZoom(1.5);
    editorState.setCurrentPage(3);
    editorState.setSidebarTab("annotations");
    editorState.saveSessionScroll(420, 35);

    // Reopen the same file and verify session restore
    editorState.setDocument({ ...doc });
    expect(editorState.zoom).toBeCloseTo(1.5);
    expect(editorState.currentPage).toBe(3);
    expect(editorState.activeSidebarTab).toBe("annotations");
    expect(editorState.pendingScrollRestore).toEqual({ scrollTop: 420, scrollLeft: 35 });
  });
});
