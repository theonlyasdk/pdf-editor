import type { AnnotationDto, PageBox, ToolSettings, ToolType } from "../types/editor";

export interface DrawPoint { x: number; y: number }

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
  let rect = drawingBox(points, ["Ink", "Line", "Arrow"].includes(type) ? width : 0);
  if (type === "FreeText" || type === "StickyNote" || type === "Stamp") {
    rect = { ...points[0], width: type === "StickyNote" ? 22 : 168, height: type === "StickyNote" ? 22 : type === "Stamp" ? 40 : Math.max(32, (text?.split("\n").length || 1) * settings.fontSize * 1.2 + 10) };
  }

  return {
    id: crypto.randomUUID(), page_index: page, annot_type: type, rect,
    color: stroke, fill_color: settings.fillColor, stroke_width: width, opacity,
    ...(type === "FreeText" ? {
      font_size: settings.fontSize,
      font_family: settings.fontFamily.includes("Times") ? "Times-Roman" : settings.fontFamily.includes("Courier") ? "Courier" : "Helvetica",
    } : {}),
    points: hasPath ? [points] : null, text, author: settings.author,
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
