import { beforeEach, describe, expect, it } from "vitest";
import { KEYBOARD_SHORTCUTS } from "../../src/components/ShortcutsModal";
import { DEFAULT_PREFERENCES, editorState } from "../../src/state/editorState";
import { DocumentDto } from "../../src/types/editor";

describe("Preferences, Navigation & Workspace State", () => {
  const mockDoc: DocumentDto = {
    file_path: "/dummy/prefs.pdf",
    file_name: "prefs.pdf",
    page_count: 3,
    pages: [
      { index: 0, width: 612, height: 792, rotation: 0, media_box: { x: 0, y: 0, width: 612, height: 792 } },
      { index: 1, width: 612, height: 792, rotation: 0, media_box: { x: 0, y: 0, width: 612, height: 792 } },
      { index: 2, width: 612, height: 792, rotation: 0, media_box: { x: 0, y: 0, width: 612, height: 792 } },
    ],
    metadata: { page_count: 3, file_size_bytes: 2048, is_encrypted: false },
    can_undo: false,
    can_redo: false,
    is_dirty: false,
    revision_id: 1,
  };

  beforeEach(() => {
    editorState.resetPreferences();
    editorState.setDocument(mockDoc);
  });

  it("updates and resets preferences while syncing toolSettings", () => {
    expect(editorState.preferences).toEqual(DEFAULT_PREFERENCES);

    editorState.updatePreferences({
      themeMode: "dark",
      defaultViewMode: "spread",
      defaultZoom: "fit-width",
      smoothZoom: true,
      units: "mm",
      author: "Alice",
      makeBackup: false,
      autosaveIntervalSec: 60,
    });

    expect(editorState.theme).toBe("dark");
    expect(editorState.preferences.defaultViewMode).toBe("spread");
    expect(editorState.preferences.defaultZoom).toBe("fit-width");
    expect(editorState.preferences.smoothZoom).toBe(true);
    expect(editorState.toolSettings.units).toBe("mm");
    expect(editorState.toolSettings.author).toBe("Alice");
    expect(editorState.preferences.makeBackup).toBe(false);
    expect(editorState.preferences.autosaveIntervalSec).toBe(60);

    // Updating toolSettings keeps preferences in sync
    editorState.updateToolSettings({ units: "in", author: "Bob" });
    expect(editorState.preferences.units).toBe("in");
    expect(editorState.preferences.author).toBe("Bob");

    editorState.resetPreferences();
    expect(editorState.preferences).toEqual(DEFAULT_PREFERENCES);
    expect(editorState.toolSettings.units).toBe("pt");
    expect(editorState.toolSettings.author).toBe("User");
  });

  it("applies defaultViewMode and defaultZoom when opening a document", () => {
    editorState.updatePreferences({
      defaultViewMode: "single",
      defaultZoom: "fit-page",
    });

    editorState.setDocument({ ...mockDoc, file_name: "next.pdf" });
    expect(editorState.viewMode).toBe("single");
    expect(editorState.zoomFitMode).toBe("fit-page");
  });

  it("tracks zoomFitMode across fit-width, fit-page, and manual zoom", () => {
    editorState.requestFitWidth();
    expect(editorState.zoomFitMode).toBe("fit-width");

    editorState.setZoom(1.25, true);
    expect(editorState.zoom).toBe(1.25);
    expect(editorState.zoomFitMode).toBe("fit-width");

    editorState.setZoom(1.5);
    expect(editorState.zoom).toBe(1.5);
    expect(editorState.zoomFitMode).toBe("custom");

    editorState.requestFitPage();
    expect(editorState.zoomFitMode).toBe("fit-page");
  });

  it("switches sidebar tabs and clears recent files", () => {
    expect(editorState.activeSidebarTab).toBe("thumbnails");
    editorState.setSidebarTab("outline");
    expect(editorState.activeSidebarTab).toBe("outline");
    editorState.setSidebarTab("annotations");
    expect(editorState.activeSidebarTab).toBe("annotations");

    editorState.addRecentFile("/a.pdf");
    expect(editorState.recentFiles.length).toBeGreaterThan(0);
    editorState.clearRecentFiles();
    expect(editorState.recentFiles).toEqual([]);
  });

  it("manages pending area redactions and clears them on new document", () => {
    editorState.addPendingRedaction({ page_index: 0, rect: { x: 10, y: 20, width: 100, height: 40 } });
    editorState.addPendingRedaction({ page_index: 1, rect: { x: 15, y: 25, width: 50, height: 30 } });
    expect(editorState.pendingRedactions).toHaveLength(2);

    editorState.removePendingRedaction(0);
    expect(editorState.pendingRedactions).toHaveLength(1);
    expect(editorState.pendingRedactions[0].page_index).toBe(1);

    editorState.setDocument(mockDoc);
    expect(editorState.pendingRedactions).toEqual([]);
  });

  it("exposes non-empty keyboard shortcuts catalog including Ctrl+,", () => {
    expect(KEYBOARD_SHORTCUTS.length).toBeGreaterThan(10);
    expect(KEYBOARD_SHORTCUTS.some((s) => s.keys === "Ctrl+,")).toBe(true);
    expect(KEYBOARD_SHORTCUTS.some((s) => s.keys === "Ctrl+K")).toBe(true);
  });

  it("clamps cropRotation and sidebarWidth cleanly", () => {
    editorState.setCropRotation(1.44);
    expect(editorState.cropRotation).toBe(1.4);
    editorState.setCropRotation(500);
    expect(editorState.cropRotation).toBe(180);
    editorState.initCropBoxForCurrentPage();
    expect(editorState.cropRotation).toBe(0);

    editorState.setSidebarWidth(80, false);
    expect(editorState.sidebarWidth).toBe(160);
    editorState.setSidebarWidth(900, false);
    expect(editorState.sidebarWidth).toBe(440);
  });
});
