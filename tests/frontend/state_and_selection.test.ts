import { describe, expect, it, beforeEach } from "vitest";
import { editorState } from "../../src/state/editorState";
import { STRINGS } from "../../src/i18n/strings";
import { DocumentDto } from "../../src/types/editor";

describe("Frontend Editor State & Selection Logic", () => {
  const mockDoc: DocumentDto = {
    file_path: "/dummy/path/doc.pdf",
    file_name: "doc.pdf",
    page_count: 5,
    pages: [
      { index: 0, width: 612, height: 792, rotation: 0, media_box: { x: 0, y: 0, width: 612, height: 792 } },
      { index: 1, width: 612, height: 792, rotation: 0, media_box: { x: 0, y: 0, width: 612, height: 792 } },
      { index: 2, width: 612, height: 792, rotation: 90, media_box: { x: 0, y: 0, width: 612, height: 792 } },
      { index: 3, width: 612, height: 792, rotation: 0, media_box: { x: 0, y: 0, width: 612, height: 792 } },
      { index: 4, width: 612, height: 792, rotation: 0, media_box: { x: 0, y: 0, width: 612, height: 792 } },
    ],
    metadata: { page_count: 5, file_size_bytes: 1024, is_encrypted: false },
    can_undo: false,
    can_redo: false,
    is_dirty: false,
    revision_id: 1,
  };

  beforeEach(() => {
    editorState.setDocument(mockDoc);
    editorState.setCropRatioMode("free");
    editorState.setTool("select");
  });

  it("should initialize with correct document metadata and page count", () => {
    expect(editorState.doc).not.toBeNull();
    expect(editorState.doc?.page_count).toBe(5);
    expect(editorState.doc?.file_name).toBe("doc.pdf");
    expect(editorState.currentPage).toBe(0);
    expect(editorState.selectedPages.size).toBe(0);
  });

  it("should clamp zoom correctly between 10% and 800%", () => {
    editorState.setZoom(0.05);
    expect(editorState.zoom).toBe(0.1);

    editorState.setZoom(10.0);
    expect(editorState.zoom).toBe(8.0);

    editorState.setZoom(1.5);
    expect(editorState.zoom).toBe(1.5);
  });

  it("should handle page selection: click, toggle, and range", () => {
    // Single click on page 1
    editorState.togglePageSelection(1, false);
    expect(Array.from(editorState.selectedPages)).toEqual([1]);
    expect(editorState.currentPage).toBe(1);

    // Toggle multi-select page 3
    editorState.togglePageSelection(3, true);
    expect(Array.from(editorState.selectedPages).sort()).toEqual([1, 3]);

    // Untoggle page 1
    editorState.togglePageSelection(1, true);
    expect(Array.from(editorState.selectedPages)).toEqual([3]);

    // Select range [0, 1, 2]
    editorState.selectPageRange([0, 1, 2]);
    expect(Array.from(editorState.selectedPages).sort()).toEqual([0, 1, 2]);
  });

  it("should select all and invert page selection", () => {
    // Select all 5 pages
    editorState.selectAllPages();
    expect(editorState.selectedPages.size).toBe(5);

    // Invert: now 0 selected
    editorState.invertPageSelection();
    expect(editorState.selectedPages.size).toBe(0);

    // Select page 2, then invert -> pages 0, 1, 3, 4
    editorState.togglePageSelection(2, false);
    editorState.invertPageSelection();
    expect(Array.from(editorState.selectedPages).sort()).toEqual([0, 1, 3, 4]);
  });

  it("should switch tools and update tool settings", () => {
    editorState.setTool("pen");
    expect(editorState.activeTool).toBe("pen");

    editorState.updateToolSettings({ strokeWidth: 5, strokeColor: "#ff0000" });
    expect(editorState.toolSettings.strokeWidth).toBe(5);
    expect(editorState.toolSettings.strokeColor).toBe("#ff0000");

    editorState.setTool("crop");
    expect(editorState.activeTool).toBe("crop");
    expect(editorState.cropBox).not.toBeNull();
    expect(editorState.cropBox?.width).toBeGreaterThan(0);

    editorState.setCropRatioMode("1:1");
    expect(editorState.toolSettings.cropRatioMode).toBe("1:1");

    editorState.setTool("trueRedact");
    expect(editorState.activeTool).toBe("trueRedact");
  });

  it("should handle crop fixed vs free aspect ratio logic", () => {
    editorState.setTool("crop");
    expect(editorState.cropBox).not.toBeNull();

    // Default is free ratio
    expect(editorState.toolSettings.cropRatioMode).toBe("free");

    // Free ratio adjustment: set arbitrary non-proportional box
    editorState.setCropBox({ x: 50, y: 50, width: 300, height: 150 });
    expect(editorState.cropBox?.width).toBe(300);
    expect(editorState.cropBox?.height).toBe(150);

    // Fixed ratio toggle: 1:1 square mode
    editorState.setCropRatioMode("1:1");
    expect(editorState.toolSettings.cropRatioMode).toBe("1:1");

    // Standard presets: 4:3 and 16:9
    editorState.setCropRatioMode("4:3");
    expect(editorState.toolSettings.cropRatioMode).toBe("4:3");

    editorState.setCropRatioMode("16:9");
    expect(editorState.toolSettings.cropRatioMode).toBe("16:9");

    // Resetting back to free ratio
    editorState.setCropRatioMode("free");
    expect(editorState.toolSettings.cropRatioMode).toBe("free");
  });

  it("should manage recent files list without duplicates", () => {
    editorState.addRecentFile("/path/a.pdf");
    editorState.addRecentFile("/path/b.pdf");
    editorState.addRecentFile("/path/a.pdf"); // Re-add duplicate
    expect(editorState.recentFiles[0]).toBe("/path/a.pdf");
    expect(editorState.recentFiles[1]).toBe("/path/b.pdf");
    expect(editorState.recentFiles.length).toBe(3); // doc.pdf + a + b
  });

  it("should verify that all UI string sections are non-empty", () => {
    expect(STRINGS.app.title).toBe("PDF Editor");
    expect(STRINGS.menu.open).toBeTruthy();
    expect(STRINGS.tools.pen).toBeTruthy();
    expect(STRINGS.tools.trueRedact).toBeTruthy();
    expect(STRINGS.redaction.warning).toContain("irreversibly");
    expect(STRINGS.crop.title).toBeTruthy();
    expect(STRINGS.emptyState.headline).toBeTruthy();
  });
});
