import { describe, expect, it } from "vitest";
import {
  computeFitZoom,
  formatMeasurement,
  formatUnitValue,
  ptToUnit,
  unitToPt,
} from "../../src/components/cropGeometry";
import {
  cssFontToPdf,
  duplicateAnnotationDto,
  inkPointsToSvgPath,
  normalizeHexColor,
  pdfFontNormalize,
  smoothInkPoints,
  updateAnnotationRect,
} from "../../src/components/drawing";
import {
  clearPendingPlacement,
  getPendingPlacement,
  setPendingPlacement,
} from "../../src/components/SignatureModal";
import type { AnnotationDto } from "../../src/types/editor";

describe("unit conversions and formatting", () => {
  it("converts points to inches and millimeters accurately", () => {
    expect(ptToUnit(612, "in")).toBeCloseTo(8.5, 5);
    expect(ptToUnit(792, "in")).toBeCloseTo(11, 5);
    expect(ptToUnit(595.2756, "mm")).toBeCloseTo(210, 2);
    expect(unitToPt(8.5, "in")).toBeCloseTo(612, 5);
    expect(unitToPt(210, "mm")).toBeCloseTo(595.2756, 2);
    expect(unitToPt(100, "pt")).toBe(100);
  });

  it("formats values according to selected measurement unit", () => {
    expect(formatUnitValue(612, "pt")).toBe("612");
    expect(formatUnitValue(612, "in")).toBe("8.50");
    expect(formatUnitValue(595.2756, "mm")).toBe("210.0");
    expect(formatMeasurement(72, "in")).toBe("1.00 in");
    expect(formatMeasurement(72, "pt")).toBe("72 pt");
  });
});

describe("fit-width and fit-page zoom calculations", () => {
  it("computes fit-width and fit-page zoom accounting for padding and bounds", () => {
    // Viewport 800x600, default padding 48 + 4 safety => 748 x 548 available
    const wZoom = computeFitZoom(800, 600, 612, 792, "fit-width");
    expect(wZoom).toBeCloseTo(748 / 612, 4);

    const pZoom = computeFitZoom(800, 600, 612, 792, "fit-page");
    expect(pZoom).toBeCloseTo(548 / 792, 4);

    // Clamping bounds
    expect(computeFitZoom(50, 50, 5000, 5000, "fit-page")).toBe(0.1);
    expect(computeFitZoom(10000, 10000, 100, 100, "fit-width")).toBe(8.0);
  });
});

describe("annotation editing and duplication helpers", () => {
  const baseAnnot: AnnotationDto = {
    id: "orig-1",
    page_index: 0,
    annot_type: "Ink",
    rect: { x: 100, y: 100, width: 50, height: 40 },
    color: "#2563eb",
    fill_color: null,
    stroke_width: 2,
    opacity: 0.9,
    text: "Note",
    points: [[{ x: 100, y: 100 }, { x: 150, y: 140 }]],
    author: "Alice",
    modified_date: "2026-01-01T00:00:00Z",
    locked: true,
  };

  it("updates annotation rect and scales/translates points inside page bounds", () => {
    const updated = updateAnnotationRect(
      baseAnnot,
      { x: 200, y: 150, width: 100, height: 80 },
      { width: 612, height: 792 },
    );
    expect(updated.rect).toEqual({ x: 200, y: 150, width: 100, height: 80 });
    expect(updated.points?.[0]).toEqual([
      { x: 200, y: 150 },
      { x: 300, y: 230 },
    ]);
  });

  it("duplicates annotation with unlocked state, new id, and bounded offset", () => {
    const dup = duplicateAnnotationDto(baseAnnot, { width: 612, height: 792 }, "Bob");
    expect(dup.id).not.toBe(baseAnnot.id);
    expect(dup.locked).toBe(false);
    expect(dup.author).toBe("Bob");
    expect(dup.rect).toEqual({ x: 114, y: 114, width: 50, height: 40 });
    expect(dup.points?.[0]).toEqual([
      { x: 114, y: 114 },
      { x: 164, y: 154 },
    ]);
  });

  it("normalizes colors and font families", () => {
    expect(normalizeHexColor("#f0a")).toBe("#ff00aa");
    expect(normalizeHexColor("#123456")).toBe("#123456");
    expect(normalizeHexColor("invalid", "#000000")).toBe("#000000");

    expect(cssFontToPdf("'Times New Roman', serif")).toBe("Times-Roman");
    expect(cssFontToPdf("'Courier New', monospace")).toBe("Courier");
    expect(cssFontToPdf("Helvetica, Arial")).toBe("Helvetica");
    expect(pdfFontNormalize("Times-Roman")).toBe("Times-Roman");
  });
});

describe("signature placement state", () => {
  it("stores and clears pending placement cleanly", () => {
    clearPendingPlacement();
    expect(getPendingPlacement()).toBeNull();

    setPendingPlacement({
      imageBase64: "data:image/png;base64,abc",
      width: 160,
      height: 60,
      opacity: 1,
      label: "Signature",
    });
    expect(getPendingPlacement()?.label).toBe("Signature");

    clearPendingPlacement();
    expect(getPendingPlacement()).toBeNull();
  });

  it("smooths pen curves while keeping endpoints and 2-point straight lines intact", () => {
    const straight = smoothInkPoints([
      { x: 0, y: 0 },
      { x: 100, y: 100 },
    ]);
    expect(straight).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 100 },
    ]);
    expect(inkPointsToSvgPath(straight)).toBe("M 0 0 L 100 100");

    const jagged = [
      { x: 0, y: 0 },
      { x: 20, y: 40 },
      { x: 40, y: 0 },
      { x: 60, y: 40 },
    ];
    const smoothed = smoothInkPoints(jagged);
    expect(smoothed[0]).toEqual({ x: 0, y: 0 });
    expect(smoothed[smoothed.length - 1]).toEqual({ x: 60, y: 40 });
    expect(smoothed.length).toBeGreaterThan(jagged.length);
    const svgPath = inkPointsToSvgPath(smoothed);
    expect(svgPath.startsWith("M 0 0 Q ")).toBe(true);
    expect(svgPath.endsWith(" L 60 40")).toBe(true);
  });
});
