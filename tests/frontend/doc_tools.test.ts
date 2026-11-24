import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, isTauriMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  isTauriMock: vi.fn(() => true),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  isTauri: isTauriMock,
}));

import { Backend } from "../../src/ipc/backend";
import { computePrintTargetWidth } from "../../src/components/ExportPrintModal";
import {
  applyOrientation,
  PAGE_PRESET_POINTS,
  pointsToUnit,
  resolveInsertIndex,
  unitToPoints,
} from "../../src/components/InsertPageModal";
import {
  buildExtractDefaultFilename,
  formatPageNumbersSummary,
  resolveMergeInsertAt,
  resolvePageSelection,
} from "../../src/components/MergeSplitModal";
import { formatFileSize, normalizeMetadataField } from "../../src/components/MetadataModal";
import { formatBatesPreview } from "../../src/components/WatermarkModal";

describe("Backend IPC wrappers", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    isTauriMock.mockReturnValue(true);
    invokeMock.mockResolvedValue({});
  });

  it("calls update_metadata and strip_metadata with exact names and args", async () => {
    const metadata = { title: "Spec", author: null };
    await Backend.updateMetadata(metadata);
    expect(invokeMock).toHaveBeenCalledWith("update_metadata", { metadata });

    await Backend.stripMetadata();
    expect(invokeMock).toHaveBeenCalledWith("strip_metadata", {});
  });

  it("calls merge_pdf and extract_pages with exact camelCase args", async () => {
    await Backend.mergePdf(["/a.pdf", "/b.pdf"], 2);
    expect(invokeMock).toHaveBeenCalledWith("merge_pdf", {
      paths: ["/a.pdf", "/b.pdf"],
      insertAt: 2,
    });

    await Backend.mergePdf(["/c.pdf"]);
    expect(invokeMock).toHaveBeenCalledWith("merge_pdf", {
      paths: ["/c.pdf"],
      insertAt: null,
    });

    await Backend.extractPages([0, 2, 4], "/out.pdf");
    expect(invokeMock).toHaveBeenCalledWith("extract_pages", {
      pages: [0, 2, 4],
      targetPath: "/out.pdf",
    });
  });

  it("calls export_pages_as_images with exact args", async () => {
    invokeMock.mockResolvedValueOnce(["/out/page-1.png"]);
    const res = await Backend.exportPagesAsImages([0], "/out", "png", 300);
    expect(invokeMock).toHaveBeenCalledWith("export_pages_as_images", {
      pages: [0],
      outputDir: "/out",
      format: "png",
      dpi: 300,
    });
    expect(res).toEqual(["/out/page-1.png"]);
  });

  it("calls annotation, redaction, watermark, outline, and crop-detect commands", async () => {
    const annotation = {
      id: "a1",
      page_index: 0,
      annot_type: "Square",
      rect: { x: 10, y: 10, width: 50, height: 50 },
      color: "#ff0000",
      stroke_width: 2,
      opacity: 1,
      locked: false,
    };
    await Backend.updateAnnotation(annotation);
    expect(invokeMock).toHaveBeenCalledWith("update_annotation", { annotation });

    const rect = { x: 20, y: 30, width: 100, height: 40 };
    await Backend.addImageAnnotation(1, rect, "data:image/png;base64,AAA=", 0.9);
    expect(invokeMock).toHaveBeenCalledWith("add_image_annotation", {
      pageIndex: 1,
      rect,
      imageBase64: "data:image/png;base64,AAA=",
      opacity: 0.9,
    });

    const items = [{ page_index: 0, rect }];
    await Backend.applyAreaRedactions(items);
    expect(invokeMock).toHaveBeenCalledWith("apply_area_redactions", { items });

    const options = { kind: "watermark" as const, text: "DRAFT", opacity: 0.3, rotation: 45 };
    await Backend.applyWatermarkOrPageNumbers(options);
    expect(invokeMock).toHaveBeenCalledWith("apply_watermark_or_page_numbers", { options });

    await Backend.getDocumentOutline();
    expect(invokeMock).toHaveBeenCalledWith("get_document_outline", {});

    await Backend.detectCropMargins(3);
    expect(invokeMock).toHaveBeenCalledWith("detect_crop_margins", { pageIndex: 3 });
  });
});

describe("MetadataModal helpers", () => {
  it("formats file sizes cleanly", () => {
    expect(formatFileSize(0)).toBe("0 B");
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(1536)).toBe("1.50 KB");
    expect(formatFileSize(2 * 1024 * 1024)).toBe("2.00 MB");
  });

  it("normalizes empty metadata fields to null", () => {
    expect(normalizeMetadataField("   ")).toBeNull();
    expect(normalizeMetadataField("  Report  ")).toBe("Report");
  });
});

describe("InsertPageModal helpers", () => {
  it("converts between pt, mm, and in accurately", () => {
    expect(pointsToUnit(72, "in")).toBeCloseTo(1, 5);
    expect(unitToPoints(1, "in")).toBeCloseTo(72, 5);
    expect(pointsToUnit(72, "mm")).toBeCloseTo(25.4, 5);
    expect(unitToPoints(25.4, "mm")).toBeCloseTo(72, 5);
    expect(pointsToUnit(612, "pt")).toBe(612);
    expect(PAGE_PRESET_POINTS.letter).toEqual({ width: 612, height: 792 });
  });

  it("applies portrait/landscape orientation and resolves insertion indices", () => {
    expect(applyOrientation(612, 792, "landscape")).toEqual({ width: 792, height: 612 });
    expect(applyOrientation(792, 612, "portrait")).toEqual({ width: 612, height: 792 });
    expect(resolveInsertIndex("start", 2, 5)).toBe(0);
    expect(resolveInsertIndex("before-current", 2, 5)).toBe(2);
    expect(resolveInsertIndex("after-current", 2, 5)).toBe(3);
    expect(resolveInsertIndex("end", 2, 5)).toBe(5);
  });
});

describe("MergeSplitModal helpers", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    isTauriMock.mockReturnValue(true);
  });

  it("resolves all, current, selected, and range page scopes", async () => {
    expect(await resolvePageSelection("all", "", 1, new Set(), 4)).toEqual([0, 1, 2, 3]);
    expect(await resolvePageSelection("current", "", 2, new Set(), 4)).toEqual([2]);
    expect(await resolvePageSelection("selected", "", 0, new Set([3, 1]), 4)).toEqual([1, 3]);

    invokeMock.mockResolvedValueOnce([0, 2]);
    expect(await resolvePageSelection("range", "1, 3", 0, new Set(), 4)).toEqual([0, 2]);
    expect(invokeMock).toHaveBeenCalledWith("evaluate_range", { expression: "1, 3", totalPages: 4 });
  });

  it("formats page summaries and validates merge insertion positions", () => {
    expect(formatPageNumbersSummary([0, 1, 4])).toBe("3 pages (1, 2, 5)");
    expect(formatPageNumbersSummary([2])).toBe("1 page (3)");
    expect(resolveMergeInsertAt("end", 1, 5, 1)).toBeNull();
    expect(resolveMergeInsertAt("start", 1, 5, 1)).toBe(0);
    expect(resolveMergeInsertAt("before-current", 2, 5, 1)).toBe(2);
    expect(resolveMergeInsertAt("after-current", 2, 5, 1)).toBe(3);
    expect(resolveMergeInsertAt("custom", 2, 5, 4)).toBe(3);
    expect(() => resolveMergeInsertAt("custom", 2, 5, 9)).toThrow();
    expect(buildExtractDefaultFilename("contract.pdf")).toBe("contract-extracted.pdf");
  });
});

describe("ExportPrintModal & WatermarkModal helpers", () => {
  it("computes print target pixel widths and formats Bates numbers", () => {
    expect(computePrintTargetWidth(612, 150)).toBe(1275);
    expect(computePrintTargetWidth(612, 300)).toBe(2550);
    expect(formatBatesPreview("EXH-", 1, 6)).toBe("EXH-000001");
    expect(formatBatesPreview("DOC_", 42, 4)).toBe("DOC_0042");
  });
});
