import type { PageBox } from "../types/editor";

export function resizeCrop(
  box: PageBox,
  handle: string,
  dx: number,
  dy: number,
  page: Pick<PageBox, "width" | "height">,
  ratio?: number,
): PageBox {
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  if (handle === "move") {
    return {
      ...box,
      x: clamp(box.x + dx, 0, page.width - box.width),
      y: clamp(box.y + dy, 0, page.height - box.height),
    };
  }

  const horizontal = handle.includes("w") ? -1 : Number(handle.includes("e"));
  const vertical = handle.includes("n") ? -1 : Number(handle.includes("s"));
  const anchorX = box.x + (horizontal < 0 ? box.width : horizontal === 0 ? box.width / 2 : 0);
  const anchorY = box.y + (vertical < 0 ? box.height : vertical === 0 ? box.height / 2 : 0);
  const maxWidth = horizontal < 0 ? anchorX : horizontal > 0 ? page.width - anchorX : page.width;
  const maxHeight = vertical < 0 ? anchorY : vertical > 0 ? page.height - anchorY : page.height;
  let width = horizontal ? clamp(box.width + horizontal * dx, Math.min(box.width, 24), maxWidth) : box.width;
  let height = vertical ? clamp(box.height + vertical * dy, Math.min(box.height, 24), maxHeight) : box.height;

  if (ratio) {
    // Project a corner's pointer onto the aspect-ratio diagonal so changing direction
    // doesn't switch between competing width and height calculations.
    const projected = horizontal && vertical
      ? ((box.width + horizontal * dx) * ratio + box.height + vertical * dy) / (ratio * ratio + 1)
      : horizontal ? width / ratio : height;
    const upper = Math.min(maxHeight, maxWidth / ratio);
    const lower = Math.min(box.height, box.width / ratio, Math.max(24, 24 / ratio), upper);
    height = clamp(projected, lower, upper);
    width = height * ratio;
  }

  return {
    x: horizontal < 0 ? anchorX - width : horizontal > 0 ? anchorX : clamp(anchorX - width / 2, 0, page.width - width),
    y: vertical < 0 ? anchorY - height : vertical > 0 ? anchorY : clamp(anchorY - height / 2, 0, page.height - height),
    width,
    height,
  };
}

export type MeasurementUnit = "pt" | "mm" | "in";

const PT_PER_INCH = 72;
const MM_PER_INCH = 25.4;

/** Convert PDF points to the requested display unit. */
export function ptToUnit(pt: number, unit: MeasurementUnit): number {
  if (unit === "mm") return (pt * MM_PER_INCH) / PT_PER_INCH;
  if (unit === "in") return pt / PT_PER_INCH;
  return pt;
}

/** Convert a value in the given unit back to PDF points. */
export function unitToPt(value: number, unit: MeasurementUnit): number {
  if (unit === "mm") return (value * PT_PER_INCH) / MM_PER_INCH;
  if (unit === "in") return value * PT_PER_INCH;
  return value;
}

export function unitStep(unit: MeasurementUnit): string {
  if (unit === "mm") return "0.1";
  if (unit === "in") return "0.01";
  return "1";
}

export function formatUnitValue(pt: number, unit: MeasurementUnit): string {
  const val = ptToUnit(pt, unit);
  if (unit === "mm") return val.toFixed(1);
  if (unit === "in") return val.toFixed(2);
  return String(Math.round(val));
}

export function formatMeasurement(pt: number, unit: MeasurementUnit): string {
  return `${formatUnitValue(pt, unit)} ${unit}`;
}

/** Compute clamped zoom level for fit-width or fit-page within viewport bounds. */
export function computeFitZoom(
  viewportWidth: number,
  viewportHeight: number,
  contentWidth: number,
  contentHeight: number,
  mode: "fit-width" | "fit-page",
  paddingX = 48,
  paddingY = 48,
): number {
  const availW = Math.max(80, viewportWidth - paddingX - 4);
  const availH = Math.max(80, viewportHeight - paddingY - 4);
  const widthZoom = availW / Math.max(1, contentWidth);
  const heightZoom = availH / Math.max(1, contentHeight);
  const raw = mode === "fit-width" ? widthZoom : Math.min(widthZoom, heightZoom);
  const clamped = Math.min(8.0, Math.max(0.1, raw));
  return Math.round(clamped * 10000) / 10000;
}
