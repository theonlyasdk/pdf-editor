import type { AnnotationDto, PageBox, ToolSettings, ToolType } from "../types/editor";

export interface DrawPoint { x: number; y: number }

export function filterInkPoints(points: DrawPoint[], minStep = 1.5): DrawPoint[] {
  if (points.length <= 2) return points.map((p) => ({ ...p }));
  const filtered: DrawPoint[] = [{ ...points[0] }];
  for (let i = 1; i < points.length - 1; i++) {
    const prev = filtered[filtered.length - 1];
    const curr = points[i];
    if (Math.hypot(curr.x - prev.x, curr.y - prev.y) >= minStep) {
      filtered.push({ ...curr });
    }
  }
  const last = points[points.length - 1];
  const prev = filtered[filtered.length - 1];
  if (Math.hypot(last.x - prev.x, last.y - prev.y) > 0.01 || filtered.length === 1) {
    filtered.push({ ...last });
  }
  return filtered;
}

export function smoothInkPoints(points: DrawPoint[], passes = 2): DrawPoint[] {
  let curr = filterInkPoints(points, 1.5);
  if (curr.length <= 2) return curr;
  for (let pass = 0; pass < passes; pass++) {
    const next: DrawPoint[] = [curr[0]];
    for (let i = 0; i < curr.length - 1; i++) {
      const p0 = curr[i];
      const p1 = curr[i + 1];
      if (i > 0) {
        next.push({ x: 0.75 * p0.x + 0.25 * p1.x, y: 0.75 * p0.y + 0.25 * p1.y });
      }
      if (i < curr.length - 2) {
        next.push({ x: 0.25 * p0.x + 0.75 * p1.x, y: 0.25 * p0.y + 0.75 * p1.y });
      }
    }
    next.push(curr[curr.length - 1]);
    curr = next;
  }
  return curr;
}

export function inkPointsToSvgPath(points: DrawPoint[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  if (points.length === 2) {
    return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
  }
  const parts = [`M ${points[0].x} ${points[0].y}`];
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i];
    const next = points[i + 1];
    const midX = (p.x + next.x) / 2;
    const midY = (p.y + next.y) / 2;
    parts.push(`Q ${p.x} ${p.y} ${midX} ${midY}`);
  }
  const last = points[points.length - 1];
  parts.push(`L ${last.x} ${last.y}`);
  return parts.join(" ");
}

export interface AreaRedactItem {
  page_index: number;
  rect: PageBox;
}

export type ExtendedAnnotationDto = AnnotationDto & {
  image_base64?: string | null;
};

/** Normalize CSS hex color strings to #rrggbb for native color inputs. */
export function normalizeHexColor(color: string | null | undefined, fallback = "#2563eb"): string {
  if (!color) return fallback;
  const trimmed = color.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    const [, r, g, b] = trimmed;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return fallback;
}

export function cssFontToPdf(fontFamily: string): string {
  if (fontFamily.includes("Times")) return "Times-Roman";
  if (fontFamily.includes("Courier")) return "Courier";
  return "Helvetica";
}

export function pdfFontNormalize(fontFamily?: string | null): "Helvetica" | "Times-Roman" | "Courier" {
  if (!fontFamily) return "Helvetica";
  if (fontFamily.includes("Times")) return "Times-Roman";
  if (fontFamily.includes("Courier")) return "Courier";
  return "Helvetica";
}

/** Update an annotation's bounding box and transform any vector points to match. */
export function updateAnnotationRect(
  annotation: AnnotationDto,
  nextRect: PageBox,
  pageBounds?: Pick<PageBox, "width" | "height">,
): AnnotationDto {
  const width = Math.max(2, pageBounds ? Math.min(pageBounds.width, nextRect.width) : nextRect.width);
  const height = Math.max(2, pageBounds ? Math.min(pageBounds.height, nextRect.height) : nextRect.height);
  const x = pageBounds
    ? Math.max(0, Math.min(pageBounds.width - width, nextRect.x))
    : Math.max(0, nextRect.x);
  const y = pageBounds
    ? Math.max(0, Math.min(pageBounds.height - height, nextRect.y))
    : Math.max(0, nextRect.y);
  const clamped: PageBox = { x, y, width, height };

  const old = annotation.rect;
  const sx = old.width > 0 ? width / old.width : 1;
  const sy = old.height > 0 ? height / old.height : 1;
  const points = annotation.points
    ? annotation.points.map((stroke) =>
        stroke.map((pt) => ({
          x: clamped.x + (pt.x - old.x) * sx,
          y: clamped.y + (pt.y - old.y) * sy,
        })),
      )
    : annotation.points;

  return {
    ...annotation,
    rect: clamped,
    points,
  };
}

/** Clone an annotation with a fresh ID and slight offset within page bounds. */
export function duplicateAnnotationDto(
  annotation: AnnotationDto,
  pageBounds?: Pick<PageBox, "width" | "height">,
  author?: string,
): AnnotationDto {
  const offset = 14;
  const targetX =
    pageBounds && annotation.rect.x + annotation.rect.width + offset > pageBounds.width
      ? Math.max(0, annotation.rect.x - offset)
      : annotation.rect.x + offset;
  const targetY =
    pageBounds && annotation.rect.y + annotation.rect.height + offset > pageBounds.height
      ? Math.max(0, annotation.rect.y - offset)
      : annotation.rect.y + offset;

  const moved = updateAnnotationRect(
    annotation,
    { ...annotation.rect, x: targetX, y: targetY },
    pageBounds,
  );

  return {
    ...moved,
    id: crypto.randomUUID(),
    locked: false,
    author: author ?? annotation.author,
    modified_date: new Date().toISOString(),
  };
}

const annotationTypes: Partial<Record<ToolType, AnnotationDto["annot_type"]>> = {
  pen: "Ink", highlighter: "Ink", rectangle: "Square", circle: "Circle",
  line: "Line", arrow: "Arrow", highlight: "Highlight", underline: "Underline",
  strikeout: "StrikeOut", squiggly: "Squiggly", freeText: "FreeText",
  stickyNote: "StickyNote", stamp: "Stamp",
};

export function drawingBox(points: DrawPoint[], padding = 0): PageBox {
  let left = points[0].x, right = left, top = points[0].y, bottom = top;
  for (const { x, y } of points) {
    left = Math.min(left, x); right = Math.max(right, x);
    top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  return { x: left - padding, y: top - padding, width: Math.max(1, right - left + padding * 2), height: Math.max(1, bottom - top + padding * 2) };
}

export function drawingStyle(tool: ToolType, settings: ToolSettings) {
  return {
    stroke: tool === "highlight" ? "#ffe04a" : settings.strokeColor,
    width: settings.strokeWidth,
    opacity: tool === "highlight" ? 0.4 : tool === "highlighter" ? settings.opacity * 0.45 : settings.opacity,
  };
}

export function buildAnnotation(tool: ToolType, page: number, points: DrawPoint[], settings: ToolSettings, text: string | null): AnnotationDto | null {
  const type = annotationTypes[tool];
  if (!type) return null;
  const { stroke, width, opacity } = drawingStyle(tool, settings);
  const hasPath = type === "Ink" || type === "Line" || type === "Arrow";
  const finalPoints = tool === "pen" ? smoothInkPoints(points) : points;
  let rect = drawingBox(finalPoints, ["Ink", "Line", "Arrow"].includes(type) ? width : 0);
  if (type === "FreeText" || type === "StickyNote" || type === "Stamp") {
    rect = { ...finalPoints[0], width: type === "StickyNote" ? 22 : 168, height: type === "StickyNote" ? 22 : type === "Stamp" ? 40 : Math.max(32, (text?.split("\n").length || 1) * settings.fontSize * 1.2 + 10) };
  }

  return {
    id: crypto.randomUUID(), page_index: page, annot_type: type, rect,
    color: stroke, fill_color: settings.fillColor, stroke_width: width, opacity,
    ...(type === "FreeText" ? {
      font_size: settings.fontSize,
      font_family: cssFontToPdf(settings.fontFamily),
    } : {}),
    points: hasPath ? [finalPoints] : null, text, author: settings.author,
    modified_date: new Date().toISOString(), locked: false,
  };
}

export function requestAnnotationText(title: string): Promise<string | null> {
  const dialog = document.createElement("dialog");
  dialog.className = "annotation-text-dialog";
  dialog.setAttribute("aria-label", title);
  dialog.innerHTML = `
    <form method="dialog">
      <label for="annotation-text"></label>
      <textarea class="ui-input" id="annotation-text" rows="3" required autofocus></textarea>
      <div class="annotation-text-actions">
        <button class="ui-button ui-button--outline" type="button">Cancel</button>
        <button class="ui-button ui-button--default" value="add">Add</button>
      </div>
    </form>`;
  dialog.querySelector("label")!.textContent = title;
  dialog.querySelector('button[type="button"]')!.addEventListener("click", () => dialog.close());
  document.body.appendChild(dialog);
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => {
      resolve(dialog.returnValue === "add" ? dialog.querySelector("textarea")!.value.trim() : null);
      dialog.remove();
    }, { once: true });
  });
}
