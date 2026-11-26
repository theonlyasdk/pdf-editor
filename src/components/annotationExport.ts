import { isTauri } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import type { AnnotationDto } from "../types/editor";

const ANNOT_TYPE_LABELS: Record<string, string> = {
  freeText: "Free Text",
  stickyNote: "Sticky Note",
  highlight: "Highlight",
  underline: "Underline",
  strikeout: "Strikethrough",
  squiggly: "Squiggly",
  pen: "Pen",
  highlighter: "Highlighter",
  rectangle: "Rectangle",
  circle: "Ellipse",
  line: "Line",
  arrow: "Arrow",
  stamp: "Stamp",
  image: "Signature / Image",
};

export function formatAnnotTypeLabel(type: string): string {
  return ANNOT_TYPE_LABELS[type] ?? type;
}

function pageDisplay(pageIndex: number, pageLabels?: Array<string | null | undefined>): string {
  const physical = pageIndex + 1;
  const label = pageLabels?.[pageIndex];
  return label && label !== String(physical) ? `${label} (p. ${physical})` : `${physical}`;
}

export function formatAnnotationsMarkdown(
  annotations: AnnotationDto[],
  docName: string,
  pageLabels?: Array<string | null | undefined>
): string {
  const sorted = [...annotations].sort((a, b) => a.page_index - b.page_index);
  const lines: string[] = [
    `# Annotations — ${docName}`,
    "",
    `Total annotations: ${sorted.length}`,
    "",
  ];

  let currentPage = -1;
  for (const annot of sorted) {
    if (annot.page_index !== currentPage) {
      currentPage = annot.page_index;
      lines.push(`## Page ${pageDisplay(currentPage, pageLabels)}`, "");
    }
    const typeLabel = formatAnnotTypeLabel(annot.annot_type);
    const author = annot.author?.trim() || "Unknown";
    const metaParts = [`**${typeLabel}**`, `by ${author}`];
    if (annot.modified_date) {
      metaParts.push(`(${annot.modified_date})`);
    }
    lines.push(`- ${metaParts.join(" ")}`);
    const text = annot.text?.trim();
    if (text) {
      for (const textLine of text.split(/\r?\n/)) {
        lines.push(`  > ${textLine}`);
      }
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function formatAnnotationsCsv(
  annotations: AnnotationDto[],
  pageLabels?: Array<string | null | undefined>
): string {
  const sorted = [...annotations].sort((a, b) => a.page_index - b.page_index);
  const header = ["page", "page_label", "type", "author", "modified_date", "color", "text"].join(",");
  const rows = sorted.map((annot) => {
    const physical = String(annot.page_index + 1);
    const label = pageLabels?.[annot.page_index] ?? physical;
    return [
      physical,
      label,
      formatAnnotTypeLabel(annot.annot_type),
      annot.author?.trim() || "Unknown",
      annot.modified_date || "",
      annot.color || "",
      annot.text?.trim() || "",
    ]
      .map(csvEscape)
      .join(",");
  });
  return `${[header, ...rows].join("\r\n")}\r\n`;
}

export async function exportAnnotationsToFile(
  format: "markdown" | "csv",
  annotations: AnnotationDto[],
  docName: string,
  pageLabels?: Array<string | null | undefined>
): Promise<boolean> {
  if (annotations.length === 0) return false;
  const baseName = docName.replace(/\.pdf$/i, "") || "annotations";
  const ext = format === "markdown" ? "md" : "csv";
  const defaultFile = `${baseName}-annotations.${ext}`;
  const content =
    format === "markdown"
      ? formatAnnotationsMarkdown(annotations, docName, pageLabels)
      : formatAnnotationsCsv(annotations, pageLabels);

  if (isTauri()) {
    const targetPath = await save({
      defaultPath: defaultFile,
      filters: [
        format === "markdown"
          ? { name: "Markdown", extensions: ["md"] }
          : { name: "CSV", extensions: ["csv"] },
      ],
    });
    if (!targetPath) return false;
    await writeTextFile(targetPath, content);
    return true;
  }

  const mime = format === "markdown" ? "text/markdown;charset=utf-8" : "text/csv;charset=utf-8";
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = defaultFile;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return true;
}
