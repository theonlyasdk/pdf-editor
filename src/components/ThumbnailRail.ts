import { Ellipsis } from "lucide";
import { icon } from "./ui/icon";
import { showContextMenu, showPageMenu } from "./EditorContextMenu";
import { DocumentDto } from "../types/editor";
import { PageRasterQueue } from "./ui/PageRasterQueue";
import { STRINGS } from "../i18n/strings";
import { Backend } from "../ipc/backend";
import { editorState } from "../state/editorState";
import { toast } from "./Toast";

export class ThumbnailRailView {
  private element: HTMLElement;
  private draggedPageIndex: number | null = null;
  private raster: PageRasterQueue | null = null;
  private renderedDocument: DocumentDto | null = null;
  private selection = "";
  private documentVersion = -1;
  private rasterVersion = -1;
  private activePage = -1;

  constructor(element: HTMLElement) {
    this.element = element;
    this.render();
    editorState.subscribe(() => this.render());
  }

  private render() {
    if (!editorState.doc) {
      this.raster?.reset();
      this.renderedDocument = null;
      this.element.style.display = "none";
      return;
    }
    this.element.style.display = "flex";
    this.element.className = "thumbnail-rail";

    const doc = editorState.doc;
    const selectedCount = editorState.selectedPages.size;
    const selection = `${editorState.currentPage}:${[...editorState.selectedPages].join(",")}`;
    const rebuilt = this.documentVersion !== editorState.documentVersion || this.renderedDocument?.page_count !== doc.page_count;
    if (!rebuilt && this.rasterVersion !== editorState.rasterVersion) {
      this.rasterVersion = editorState.rasterVersion;
      for (const card of this.element.querySelectorAll<HTMLElement>(".thumbnail-card")) {
        const index = Number(card.dataset.pageIndex);
        const page = doc.pages[index];
        const preview = card.querySelector<HTMLElement>(".thumbnail-preview")!;
        preview.style.aspectRatio = `${page.width} / ${page.height}`;
        card.querySelector(".thumbnail-detail")!.textContent = [page.rotation ? `${page.rotation}°` : "", page.crop_box ? "Cropped" : ""].filter(Boolean).join(" · ");
        this.raster?.add(preview, preview.querySelector("img")!, index, 200);
      }
    }
    if (!rebuilt) {
      this.renderedDocument = doc;
      if (selection === this.selection) return;
      this.selection = selection;
      for (const card of this.element.querySelectorAll<HTMLElement>(".thumbnail-card")) {
        const index = Number(card.dataset.pageIndex);
        card.classList.toggle("selected", editorState.selectedPages.has(index));
        const current = index === editorState.currentPage;
        card.classList.toggle("current", current);
        if (current) card.setAttribute("aria-current", "page");
        else card.removeAttribute("aria-current");
      }
      const feedback = this.element.querySelector("#rail-range-feedback");
      if (feedback) feedback.textContent = selectedCount
        ? `${selectedCount} selected`
        : "";
      this.followCurrentPage();
      return;
    }
    this.activePage = -1;
    this.documentVersion = editorState.documentVersion;
    this.rasterVersion = editorState.rasterVersion;
    this.raster?.reset();
    this.renderedDocument = doc;
    this.selection = selection;

    this.element.innerHTML = `
      <div class="rail-header">
        <div class="rail-tools">
          <span class="font-semibold">Pages <span class="rail-page-count">${doc.page_count}</span></span>
          <button class="ui-button ui-button--tool" id="rail-selection-menu" type="button" aria-label="Page selection options" aria-haspopup="menu">${icon(Ellipsis)}</button>
        </div>
        <div class="rail-range">
          <label class="property-label" for="rail-range-input">Select by range</label>
          <input type="text" class="ui-input" id="rail-range-input" placeholder="1-5, odd" title="Enter a page range and press Enter" />
          <div id="rail-range-feedback" class="text-xs text-muted-foreground mt-1" style="font-size: 11px;">
            ${selectedCount > 0 ? `${selectedCount} selected` : ""}
          </div>
        </div>
      </div>
      <div class="thumbnail-list" id="thumbnail-cards-list">
        <!-- Rendered cards -->
      </div>
    `;

    this.renderThumbnailCards();
    this.bindRailEvents();
    this.followCurrentPage();
  }

  private followCurrentPage() {
    if (this.activePage === editorState.currentPage) return;
    this.activePage = editorState.currentPage;
    const list = this.element.querySelector<HTMLElement>(".thumbnail-list");
    const card = list?.querySelector<HTMLElement>(`[data-page-index="${this.activePage}"]`);
    if (!list || !card) return;
    const bounds = list.getBoundingClientRect();
    const item = card.getBoundingClientRect();
    if (item.top < bounds.top) list.scrollTop += item.top - bounds.top - 6;
    else if (item.bottom > bounds.bottom) list.scrollTop += item.bottom - bounds.bottom + 6;
  }

  private renderThumbnailCards() {
    const container = this.element.querySelector("#thumbnail-cards-list");
    if (!container || !editorState.doc) return;

    container.innerHTML = "";
    const doc = editorState.doc;
    this.raster = new PageRasterQueue(container as HTMLElement);

    for (let i = 0; i < doc.page_count; i++) {
      const pageInfo = doc.pages[i];
      const isSelected = editorState.selectedPages.has(i);
      const isCurrent = editorState.currentPage === i;

      const card = document.createElement("div");
      card.className = `thumbnail-card ${isSelected ? "selected" : ""} ${isCurrent ? "current" : ""}`;
      card.setAttribute("draggable", "true");
      card.tabIndex = 0;
      card.setAttribute("aria-label", `Page ${i + 1}`);
      if (isCurrent) card.setAttribute("aria-current", "page");
      card.addEventListener("contextmenu", (event) => showPageMenu(event, i));
      card.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          card.click();
        }
      });
      card.setAttribute("data-page-index", i.toString());

      // Header row with page number and rotation indicator
      const metaRow = document.createElement("div");
      metaRow.className = "flex justify-between w-full px-1";
      metaRow.innerHTML = `
        <span class="thumbnail-label">${i + 1}</span>
        <span class="thumbnail-detail">${[pageInfo.rotation ? `${pageInfo.rotation}°` : "", pageInfo.crop_box ? "Cropped" : ""].filter(Boolean).join(" · ")}</span>
      `;
      card.appendChild(metaRow);

      // Thumbnail Image
      const img = document.createElement("img");
      img.className = "thumbnail-img";
      img.alt = `Page ${i + 1}`;

      const preview = document.createElement("div");
      preview.className = "thumbnail-preview";
      preview.style.aspectRatio = `${pageInfo.width} / ${pageInfo.height}`;
      preview.appendChild(img);
      card.appendChild(preview);
      this.raster.add(preview, img, i, 200);

      // Drag and drop events for page reordering
      card.addEventListener("dragstart", (e) => {
        this.draggedPageIndex = i;
        card.style.opacity = "0.5";
        e.dataTransfer?.setData("text/plain", i.toString());
      });

      card.addEventListener("dragend", () => {
        this.draggedPageIndex = null;
        card.style.opacity = "1";
        document.querySelectorAll(".drag-insert-marker").forEach((el) => el.remove());
      });

      card.addEventListener("dragover", (e) => {
        e.preventDefault();
        if (this.draggedPageIndex === null || this.draggedPageIndex === i) return;

        // Show insertion line
        document.querySelectorAll(".drag-insert-marker").forEach((el) => el.remove());
        const marker = document.createElement("div");
        marker.className = "drag-insert-marker";
        card.before(marker);
      });

      card.addEventListener("drop", async (e) => {
        e.preventDefault();
        document.querySelectorAll(".drag-insert-marker").forEach((el) => el.remove());
        if (this.draggedPageIndex === null || this.draggedPageIndex === i) return;

        const fromIdx = this.draggedPageIndex;
        const toIdx = i;

        if (editorState.doc) {
          const currentPages = Array.from({ length: editorState.doc.page_count }, (_, k) => k);
          const [moved] = currentPages.splice(fromIdx, 1);
          currentPages.splice(toIdx, 0, moved);

          try {
            const updated = await Backend.reorderPages(currentPages);
            editorState.updateDocument(updated);
            editorState.setCurrentPage(toIdx);
            toast.show({ message: `Moved Page ${fromIdx + 1} to position ${toIdx + 1}`, type: "info" });
          } catch (err: any) {
            toast.show({ message: `Reorder failed: ${err}`, type: "error" });
          }
        }
      });

      // Click selection
      card.addEventListener("click", (e) => {
        const isMulti = e.ctrlKey || e.metaKey;
        const isRange = e.shiftKey;

        if (isRange && editorState.doc) {
          const start = Math.min(editorState.currentPage, i);
          const end = Math.max(editorState.currentPage, i);
          const range: number[] = [];
          for (let k = start; k <= end; k++) range.push(k);
          editorState.selectPageRange(range);
        } else {
          editorState.togglePageSelection(i, isMulti);
        }

        // Jump main view to this page
        window.dispatchEvent(new CustomEvent("jump-to-page", { detail: { pageIndex: i } }));
      });

      container.appendChild(card);
    }
  }

  private bindRailEvents() {
    this.element.querySelector<HTMLButtonElement>("#rail-selection-menu")?.addEventListener("click", (event) => {
      showContextMenu(event, "Page selection", [
        { label: "Select all", run: () => editorState.selectAllPages() },
        { label: "Invert selection", run: () => editorState.invertPageSelection() },
        { label: "Clear selection", run: () => editorState.selectPageRange([]) },
      ]);
    });

    const rangeInput = this.element.querySelector("#rail-range-input") as HTMLInputElement | null;
    const rangeFeedback = this.element.querySelector("#rail-range-feedback");

    rangeInput?.addEventListener("input", async () => {
      const val = rangeInput.value.trim();
      if (!val || !editorState.doc) {
        if (rangeFeedback) rangeFeedback.textContent = "";
        return;
      }

      try {
        const matched = await Backend.evaluateRange(val, editorState.doc.page_count);
        if (rangeFeedback) {
          rangeFeedback.innerHTML = `<span class="text-success font-semibold">${matched.length} page(s) match (${matched.map((p) => p + 1).join(", ")})</span>`;
        }
      } catch (err: any) {
        if (rangeFeedback) {
          rangeFeedback.innerHTML = `<span class="text-destructive">${err.toString()}</span>`;
        }
      }
    });

    rangeInput?.addEventListener("keydown", async (e) => {
      if (e.key === "Enter") {
        const val = rangeInput.value.trim();
        if (!val || !editorState.doc) return;
        try {
          const matched = await Backend.evaluateRange(val, editorState.doc.page_count);
          editorState.selectPageRange(matched);
          toast.show({ message: `Selected ${matched.length} page(s) via range expression`, type: "info" });
        } catch (err: any) {
          toast.show({ message: `Range parse error: ${err}`, type: "error" });
        }
      }
    });
  }
}
