import { ArrowLeftRight, CheckSquare, Ellipsis, SlidersHorizontal, SquareDashed } from "lucide";
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
  private raster: PageRasterQueue | null = null;
  private renderedDocument: DocumentDto | null = null;
  private selection = "";
  private documentVersion = -1;
  private rasterVersion = -1;
  private activePage = -1;
  private lastRasterWidth = 200;
  private resizeTimer = 0;
  private resizeObserver: ResizeObserver | null = null;
  private hydratedPages = new Set<number>();
  private followRaf = 0;
  private followTargetScroll: number | null = null;
  private rangeExpanded = false;
  private suppressClickIndex: number | null = null;
  private settlingDrag = false;
  private appliedPageTokens: number[] = [];
  private dragReorder: {
    pointerId: number;
    fromIdx: number;
    toIdx: number;
    card: HTMLElement;
    container: HTMLElement;
    cards: HTMLElement[];
    origCenters: number[];
    fromStep: number;
    minDeltaY: number;
    maxDeltaY: number;
    startClientX: number;
    startClientY: number;
    lastClientY: number;
    startScrollTop: number;
    origCenterY: number;
    lifted: boolean;
    holdTimer: number;
    autoScrollRaf: number;
    liftAnimRaf: number;
    abort: AbortController;
  } | null = null;

  constructor(element: HTMLElement) {
    this.element = element;
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.handleResize());
      this.resizeObserver.observe(this.element);
    }
    this.render();
    editorState.subscribe(() => this.render());
  }

  private computeTargetRasterWidth(): number {
    const sample = this.element.querySelector<HTMLElement>(".thumbnail-preview");
    const width = sample?.clientWidth || Math.max(120, this.element.clientWidth - 40);
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    return Math.min(640, Math.max(180, Math.ceil((width * dpr) / 60) * 60));
  }

  private handleResize() {
    if (!editorState.doc || !this.raster) return;
    this.syncThumbnailWindow();
    const nextWidth = this.computeTargetRasterWidth();
    if (nextWidth <= this.lastRasterWidth + 40) return;
    if (this.resizeTimer) window.clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => {
      this.resizeTimer = 0;
      if (!editorState.doc || !this.raster) return;
      const targetWidth = this.computeTargetRasterWidth();
      this.lastRasterWidth = targetWidth;
      for (const card of this.element.querySelectorAll<HTMLElement>(".thumbnail-card")) {
        const preview = card.querySelector<HTMLElement>(".thumbnail-preview");
        if (!preview || preview.dataset.hydrated !== "1") continue;
        const index = Number(card.dataset.pageIndex);
        const canvas = preview.querySelector<HTMLCanvasElement>(".thumbnail-img");
        if (canvas) this.raster.add(preview, canvas, index, targetWidth);
      }
    }, 120);
  }

  private render() {
    const isEmbedded = this.element.classList.contains("sidebar-tab-panel");
    if (!editorState.doc) {
      this.cancelDragReorder();
      this.stopFollowAnimation();
      this.hydratedPages.clear();
      this.appliedPageTokens = [];
      this.raster?.reset();
      this.renderedDocument = null;
      if (!isEmbedded) this.element.style.display = "none";
      return;
    }
    if (this.dragReorder?.lifted || this.settlingDrag) return;
    if (!isEmbedded) {
      this.element.style.display = "flex";
      this.element.className = "thumbnail-rail";
    }

    const doc = editorState.doc;
    const selectedCount = editorState.selectedPages.size;
    const selection = `${editorState.currentPage}:${[...editorState.selectedPages].join(",")}`;
    const rebuilt = this.documentVersion !== editorState.documentVersion || this.renderedDocument?.page_count !== doc.page_count;
    if (!rebuilt && this.rasterVersion !== editorState.rasterVersion) {
      this.rasterVersion = editorState.rasterVersion;
      this.lastRasterWidth = this.computeTargetRasterWidth();
      const cards = Array.from(this.element.querySelectorAll<HTMLElement>(".thumbnail-card"));
      const nextTokens = doc.page_revisions ?? [];
      const oldSnapshots = new Map<number, HTMLCanvasElement>();
      if (
        this.appliedPageTokens.length === cards.length &&
        nextTokens.length === doc.page_count &&
        this.appliedPageTokens.length === nextTokens.length
      ) {
        for (let idx = 0; idx < cards.length; idx++) {
          const prevToken = this.appliedPageTokens[idx];
          const card = cards[idx];
          const preview = card.querySelector<HTMLElement>(".thumbnail-preview");
          const canvas = preview?.querySelector<HTMLCanvasElement>(".thumbnail-img");
          if (
            prevToken !== undefined &&
            preview?.dataset.hydrated === "1" &&
            preview.dataset.raster === "ready" &&
            canvas &&
            canvas.width > 0 &&
            canvas.height > 0
          ) {
            const snap = document.createElement("canvas");
            snap.width = canvas.width;
            snap.height = canvas.height;
            snap.getContext("2d")?.drawImage(canvas, 0, 0);
            oldSnapshots.set(prevToken, snap);
          }
        }
      }

      for (const card of cards) {
        const index = Number(card.dataset.pageIndex);
        const key = editorState.getPageRasterKey(index);
        if (card.dataset.rasterKey === key) continue;
        card.dataset.rasterKey = key;
        const page = doc.pages[index];
        const preview = card.querySelector<HTMLElement>(".thumbnail-preview")!;
        preview.style.aspectRatio = `${page.width} / ${page.height}`;
        card.querySelector(".thumbnail-detail")!.textContent = [page.rotation ? `${page.rotation}°` : "", page.crop_box ? "Cropped" : ""].filter(Boolean).join(" · ");
        const snap = nextTokens[index] !== undefined ? oldSnapshots.get(nextTokens[index]) : undefined;
        if (snap && preview.dataset.hydrated === "1") {
          const canvas = preview.querySelector<HTMLCanvasElement>(".thumbnail-img");
          if (canvas) {
            canvas.width = snap.width;
            canvas.height = snap.height;
            canvas.getContext("2d")?.drawImage(snap, 0, 0);
            preview.dataset.raster = "ready";
            this.raster?.add(preview, canvas, index, this.lastRasterWidth);
            continue;
          }
        }
        if (preview.dataset.hydrated === "1") {
          const canvas = preview.querySelector<HTMLCanvasElement>(".thumbnail-img");
          if (canvas) this.raster?.add(preview, canvas, index, this.lastRasterWidth);
        }
      }
      this.appliedPageTokens = [...nextTokens];
    }
    if (!rebuilt) {
      this.renderedDocument = doc;
      if (selection === this.selection) return;
      this.selection = selection;
      const cards = this.element.querySelectorAll<HTMLElement>(".thumbnail-card");
      // Un-highlight any previously active/selected cards before highlighting the next one(s)
      for (const card of cards) {
        if (card.classList.contains("selected") || card.classList.contains("current") || card.hasAttribute("aria-current")) {
          card.classList.remove("selected", "current");
          card.removeAttribute("aria-current");
        }
      }
      for (const card of cards) {
        const index = Number(card.dataset.pageIndex);
        if (editorState.selectedPages.has(index)) {
          card.classList.add("selected");
        }
        if (index === editorState.currentPage) {
          card.classList.add("current");
          card.setAttribute("aria-current", "page");
        }
      }
      const feedback = this.element.querySelector<HTMLElement>("#rail-range-feedback");
      if (feedback) {
        feedback.textContent = selectedCount ? `${selectedCount} selected` : "";
        feedback.hidden = selectedCount === 0;
      }
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
        <div class="rail-range" id="rail-range-panel" ${this.rangeExpanded ? "" : "hidden"}>
          <label class="property-label" for="rail-range-input">Select by range</label>
          <input type="text" class="ui-input" id="rail-range-input" placeholder="1-5, odd" title="Enter a page range and press Enter" />
        </div>
        <div id="rail-range-feedback" class="text-xs text-muted-foreground" style="font-size: 11px;" ${selectedCount > 0 ? "" : "hidden"}>${selectedCount > 0 ? `${selectedCount} selected` : ""}</div>
      </div>
      <div class="thumbnail-list" id="thumbnail-cards-list">
        <!-- Rendered cards -->
      </div>
    `;

    this.renderThumbnailCards();
    this.appliedPageTokens = [...(doc.page_revisions ?? [])];
    this.bindRailEvents();
    this.followCurrentPage();
  }

  private stopFollowAnimation() {
    if (this.followRaf) {
      cancelAnimationFrame(this.followRaf);
      this.followRaf = 0;
    }
    this.followTargetScroll = null;
  }

  private followCurrentPage() {
    if (this.activePage === editorState.currentPage) return;
    const isInitial = this.activePage === -1;
    this.activePage = editorState.currentPage;
    const list = this.element.querySelector<HTMLElement>("#thumbnail-cards-list");
    const card = list?.querySelector<HTMLElement>(`[data-page-index="${this.activePage}"]`);
    if (!list || !card) return;
    const viewHeight = list.clientHeight;
    const itemHeight = card.offsetHeight;
    if (viewHeight <= 0 || itemHeight <= 0) return;

    const maxScroll = Math.max(0, list.scrollHeight - viewHeight);
    if (maxScroll === 0) return;

    const maxSafePeek = Math.max(6, Math.floor((viewHeight - itemHeight) / 2));
    const peek = Math.min(maxSafePeek, Math.max(56, Math.round(viewHeight * 0.14)));
    const curScroll = list.scrollTop;
    const cardTop = card.offsetTop;
    const cardBottom = cardTop + itemHeight;

    let targetScroll: number | null = null;
    if (cardTop < curScroll + peek) {
      targetScroll = Math.max(0, Math.min(maxScroll, cardTop - peek));
    } else if (cardBottom > curScroll + viewHeight - peek) {
      targetScroll = Math.max(0, Math.min(maxScroll, cardBottom - viewHeight + peek));
    }

    if (targetScroll === null) {
      this.stopFollowAnimation();
      return;
    }
    if (Math.abs(targetScroll - curScroll) < 0.5) return;

    const reduced = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (isInitial || reduced) {
      this.stopFollowAnimation();
      list.scrollTop = targetScroll;
      this.syncThumbnailWindow();
      return;
    }

    this.followTargetScroll = targetScroll;
    if (this.followRaf) return;
    let lastTime = performance.now();
    const step = (now: number) => {
      const target = this.followTargetScroll;
      const scroller = this.element.querySelector<HTMLElement>("#thumbnail-cards-list");
      if (target === null || !scroller) {
        this.followRaf = 0;
        return;
      }
      const dt = Math.min(0.05, Math.max(0.001, (now - lastTime) / 1000));
      lastTime = now;
      const current = scroller.scrollTop;
      const diff = target - current;
      if (Math.abs(diff) <= 0.75) {
        scroller.scrollTop = target;
        this.followTargetScroll = null;
        this.followRaf = 0;
        this.syncThumbnailWindow();
        return;
      }
      const alpha = 1 - Math.exp(-16 * dt);
      scroller.scrollTop = current + diff * alpha;
      this.followRaf = requestAnimationFrame(step);
    };
    this.followRaf = requestAnimationFrame(step);
  }

  private hydrateCard(cards: HTMLCollection, index: number) {
    if (this.hydratedPages.has(index) || !this.raster) return;
    const card = cards[index] as HTMLElement | undefined;
    const preview = card?.querySelector<HTMLElement>(".thumbnail-preview");
    if (!preview) return;
    const canvas = document.createElement("canvas");
    canvas.className = "thumbnail-img";
    canvas.setAttribute("aria-label", `Page ${index + 1}`);
    preview.replaceChildren(canvas);
    preview.dataset.hydrated = "1";
    this.hydratedPages.add(index);
    this.raster.add(preview, canvas, index, this.lastRasterWidth);
  }

  private syncThumbnailWindow() {
    const list = this.element.querySelector<HTMLElement>("#thumbnail-cards-list");
    if (!list || !this.raster || !editorState.doc) return;
    const cards = list.children;
    if (!cards.length) return;

    const viewHeight = list.clientHeight;
    let firstVis = 0;
    let lastVis = cards.length - 1;
    if (viewHeight > 0) {
      const viewTop = list.scrollTop;
      const viewBottom = viewTop + viewHeight;
      let lo = 0;
      let hi = cards.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const cardEl = cards[mid] as HTMLElement;
        if (cardEl.offsetTop + cardEl.offsetHeight < viewTop) lo = mid + 1;
        else hi = mid;
      }
      firstVis = lo;
      lastVis = lo;
      while (lastVis + 1 < cards.length && (cards[lastVis + 1] as HTMLElement).offsetTop <= viewBottom) {
        lastVis++;
      }
    } else {
      lastVis = Math.min(cards.length - 1, 15);
    }

    const cacheAll = editorState.preferences.cacheAllPages;
    const hydrateStart = cacheAll ? 0 : Math.max(0, firstVis - 12);
    const hydrateEnd = cacheAll ? cards.length - 1 : Math.min(cards.length - 1, lastVis + 12);
    const evictStart = Math.max(0, firstVis - 28);
    const evictEnd = Math.min(cards.length - 1, lastVis + 28);
    this.lastRasterWidth = this.computeTargetRasterWidth();

    for (let i = hydrateStart; i <= hydrateEnd; i++) {
      this.hydrateCard(cards, i);
    }
    if (!cacheAll) {
      for (const idx of [...this.hydratedPages]) {
        if (idx >= evictStart && idx <= evictEnd) continue;
        const card = cards[idx] as HTMLElement | undefined;
        const preview = card?.querySelector<HTMLElement>(".thumbnail-preview");
        if (preview) {
          this.raster.evict(preview);
          delete preview.dataset.hydrated;
          preview.replaceChildren();
        }
        this.hydratedPages.delete(idx);
      }
    }
  }

  private renderThumbnailCards() {
    const container = this.element.querySelector<HTMLElement>("#thumbnail-cards-list");
    if (!container || !editorState.doc) return;

    this.stopFollowAnimation();
    this.hydratedPages.clear();
    container.innerHTML = "";
    const doc = editorState.doc;
    this.raster = new PageRasterQueue(container, 3, {
      isPriorityPage: (page) => page === editorState.currentPage,
      shouldPreloadAll: () => editorState.preferences.cacheAllPages,
    });
    const cancelManualFollow = () => this.stopFollowAnimation();
    container.addEventListener("wheel", cancelManualFollow, { passive: true });
    container.addEventListener("pointerdown", cancelManualFollow, { passive: true });
    container.addEventListener("touchstart", cancelManualFollow, { passive: true });
    let scrollRaf = 0;
    container.addEventListener("scroll", () => {
      if (scrollRaf) return;
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = 0;
        this.syncThumbnailWindow();
      });
    }, { passive: true });

    const frag = document.createDocumentFragment();
    for (let i = 0; i < doc.page_count; i++) {
      const pageInfo = doc.pages[i];
      const isSelected = editorState.selectedPages.has(i);
      const isCurrent = editorState.currentPage === i;

      const card = document.createElement("div");
      card.className = `thumbnail-card ${isSelected ? "selected" : ""} ${isCurrent ? "current" : ""}`;
      card.tabIndex = 0;
      card.setAttribute("aria-label", `Page ${i + 1}`);
      card.dataset.rasterKey = editorState.getPageRasterKey(i);
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

      // Thumbnail Preview Shell (canvas hydrated lazily in syncThumbnailWindow)
      const preview = document.createElement("div");
      preview.className = "thumbnail-preview";
      preview.style.aspectRatio = `${pageInfo.width} / ${pageInfo.height}`;
      card.appendChild(preview);

      // Smooth hold-to-lift, Y-axis locked page drag reordering
      card.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
        if (this.dragReorder || this.settlingDrag || !editorState.doc || editorState.doc.page_count < 2) return;
        if ((e.target as Element).closest("button, input")) return;
        this.beginCardHoldDrag(e, card, i, container);
      });

      // Click selection
      card.addEventListener("click", (e) => {
        if (this.suppressClickIndex === i) {
          this.suppressClickIndex = null;
          return;
        }
        const isMulti = e.ctrlKey || e.metaKey;
        const isRange = e.shiftKey;

        if (isRange && editorState.doc) {
          const start = Math.min(editorState.currentPage, i);
          const end = Math.max(editorState.currentPage, i);
          const range: number[] = [];
          for (let k = start; k <= end; k++) range.push(k);
          editorState.selectPageRange(range);
        } else if (isMulti) {
          editorState.togglePageSelection(i, true);
        } else {
          if (editorState.selectedPages.size > 0) editorState.selectPageRange([]);
          editorState.setCurrentPage(i);
        }

        // Jump main view to this page
        window.dispatchEvent(new CustomEvent("jump-to-page", { detail: { pageIndex: i } }));
      });

      frag.appendChild(card);
    }
    container.appendChild(frag);
    this.syncThumbnailWindow();
  }

  private beginCardHoldDrag(
    downEvent: PointerEvent,
    card: HTMLElement,
    fromIdx: number,
    container: HTMLElement
  ) {
    const abort = new AbortController();
    card.classList.add("is-holding");
    let holdTimer = 0;
    let autoScrollRaf = 0;
    let liftAnimRaf = 0;
    let liftScale = 1;
    let dy = 0;
    const targetLiftScale = 1.045;
    const dragState = {
      pointerId: downEvent.pointerId,
      fromIdx,
      toIdx: fromIdx,
      card,
      container,
      cards: [] as HTMLElement[],
      origCenters: [] as number[],
      fromStep: 0,
      minDeltaY: 0,
      maxDeltaY: 0,
      startClientX: downEvent.clientX,
      startClientY: downEvent.clientY,
      lastClientY: downEvent.clientY,
      startScrollTop: container.scrollTop,
      origCenterY: 0,
      lifted: false,
      holdTimer,
      autoScrollRaf,
      liftAnimRaf,
      abort,
    };
    this.dragReorder = dragState;

    const applyCardTransform = () => {
      card.style.transform = `translate3d(0, ${dy}px, 0) scale(${liftScale})`;
    };

    const updateLayout = () => {
      if (!dragState.lifted) return;
      const scrollDelta = container.scrollTop - dragState.startScrollTop;
      const rawDy = (dragState.lastClientY - dragState.startClientY) + scrollDelta;
      dy = Math.max(dragState.minDeltaY, Math.min(dragState.maxDeltaY, rawDy));
      applyCardTransform();

      const dragCenter = dragState.origCenterY + dy;
      const centers = dragState.origCenters;
      let target = fromIdx;
      while (target + 1 < centers.length && dragCenter > centers[target + 1]) {
        target++;
      }
      while (target - 1 >= 0 && dragCenter < centers[target - 1]) {
        target--;
      }
      dragState.toIdx = target;

      const step = dragState.fromStep;
      for (let k = 0; k < dragState.cards.length; k++) {
        if (k === fromIdx) continue;
        const sibling = dragState.cards[k];
        if (fromIdx < target && k > fromIdx && k <= target) {
          sibling.style.transform = `translate3d(0, ${-step}px, 0)`;
        } else if (target < fromIdx && k >= target && k < fromIdx) {
          sibling.style.transform = `translate3d(0, ${step}px, 0)`;
        } else {
          sibling.style.transform = "";
        }
      }
    };

    const animateCardLift = () => {
      const reduced = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (reduced) {
        liftScale = targetLiftScale;
        applyCardTransform();
        return;
      }
      const startTime = performance.now();
      const duration = 180;
      const tick = (now: number) => {
        dragState.liftAnimRaf = 0;
        if (!dragState.lifted || this.dragReorder !== dragState) return;
        const t = Math.min(1, (now - startTime) / duration);
        const eased = 1 - Math.pow(1 - t, 3);
        liftScale = 1 + (targetLiftScale - 1) * eased;
        applyCardTransform();
        if (t < 1) {
          dragState.liftAnimRaf = requestAnimationFrame(tick);
        }
      };
      dragState.liftAnimRaf = requestAnimationFrame(tick);
    };

    const runAutoScroll = () => {
      if (!dragState.lifted || this.dragReorder !== dragState) {
        dragState.autoScrollRaf = 0;
        return;
      }
      let lastFrame = performance.now();
      const tick = (now: number) => {
        dragState.autoScrollRaf = 0;
        if (!dragState.lifted || this.dragReorder !== dragState) return;
        const rect = container.getBoundingClientRect();
        const zone = Math.min(56, Math.max(28, rect.height * 0.22));
        const y = dragState.lastClientY;
        let speed = 0;
        if (y < rect.top + zone) {
          const strength = Math.min(1, Math.max(0, (rect.top + zone - y) / zone));
          speed = -560 * (strength * strength * 0.7 + strength * 0.3);
        } else if (y > rect.bottom - zone) {
          const strength = Math.min(1, Math.max(0, (y - (rect.bottom - zone)) / zone));
          speed = 560 * (strength * strength * 0.7 + strength * 0.3);
        }
        if (speed === 0) return;

        const dt = Math.min(0.05, Math.max(0.001, (now - lastFrame) / 1000));
        lastFrame = now;
        const prevTop = container.scrollTop;
        const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
        container.scrollTop = Math.max(0, Math.min(maxTop, prevTop + speed * dt));
        if (container.scrollTop !== prevTop) {
          updateLayout();
          this.syncThumbnailWindow();
        }
        dragState.autoScrollRaf = requestAnimationFrame(tick);
      };
      dragState.autoScrollRaf = requestAnimationFrame(tick);
    };

    dragState.holdTimer = window.setTimeout(() => {
      if (this.dragReorder !== dragState || !card.isConnected) return;
      this.stopFollowAnimation();
      const cards = Array.from(container.querySelectorAll<HTMLElement>(".thumbnail-card"));
      if (cards.length < 2) {
        this.cancelDragReorder();
        return;
      }
      const height = card.offsetHeight;
      const gap = fromIdx < cards.length - 1
        ? Math.max(0, cards[fromIdx + 1].offsetTop - (card.offsetTop + height))
        : Math.max(0, card.offsetTop - (cards[fromIdx - 1].offsetTop + cards[fromIdx - 1].offsetHeight));
      const origCenters = cards.map((c) => c.offsetTop + c.offsetHeight / 2);
      const firstTop = cards[0].offsetTop;
      const lastCard = cards[cards.length - 1];
      const maxTop = lastCard.offsetTop + lastCard.offsetHeight - height;

      dragState.cards = cards;
      dragState.origCenters = origCenters;
      dragState.fromStep = height + gap;
      dragState.origCenterY = origCenters[fromIdx];
      dragState.minDeltaY = firstTop - card.offsetTop;
      dragState.maxDeltaY = Math.max(0, maxTop - card.offsetTop);
      dragState.startScrollTop = container.scrollTop;
      dragState.lifted = true;
      (dragState as { currentDy?: number; currentScale?: number }).currentDy = 0;
      (dragState as { currentDy?: number; currentScale?: number }).currentScale = 1;

      card.classList.remove("is-holding");
      card.classList.add("is-lifted");
      container.classList.add("is-drag-sorting");
      try {
        card.setPointerCapture(dragState.pointerId);
      } catch {
        // Ignore if pointer already detached
      }
      updateLayout();
      animateCardLift();
    }, 190);

    window.addEventListener(
      "pointermove",
      (e) => {
        if (e.pointerId !== dragState.pointerId || this.dragReorder !== dragState) return;
        if (!dragState.lifted) {
          if (Math.hypot(e.clientX - dragState.startClientX, e.clientY - dragState.startClientY) > 8) {
            this.cancelDragReorder();
          }
          return;
        }
        e.preventDefault();
        dragState.lastClientY = e.clientY;
        updateLayout();
        if (!dragState.autoScrollRaf) {
          const rect = container.getBoundingClientRect();
          const zone = Math.min(56, Math.max(28, rect.height * 0.22));
          if (e.clientY < rect.top + zone || e.clientY > rect.bottom - zone) {
            runAutoScroll();
          }
        }
      },
      { signal: abort.signal }
    );

    const endDrag = async (e: PointerEvent, canceled: boolean) => {
      if (e.pointerId !== dragState.pointerId || this.dragReorder !== dragState) return;
      const wasLifted = dragState.lifted;
      const targetIdx = dragState.toIdx;
      if (!wasLifted) {
        this.cleanupDragState(dragState);
        return;
      }

      if (dragState.holdTimer) window.clearTimeout(dragState.holdTimer);
      if (dragState.autoScrollRaf) cancelAnimationFrame(dragState.autoScrollRaf);
      if (dragState.liftAnimRaf) cancelAnimationFrame(dragState.liftAnimRaf);
      dragState.abort.abort();

      this.suppressClickIndex = fromIdx;
      window.setTimeout(() => {
        if (this.suppressClickIndex === fromIdx) this.suppressClickIndex = null;
      }, 80);

      const effectiveTarget = canceled ? fromIdx : targetIdx;
      let restDy = 0;
      if (effectiveTarget !== fromIdx) {
        const destCard = dragState.cards[effectiveTarget];
        if (destCard) {
          restDy = fromIdx < effectiveTarget
            ? destCard.offsetTop + destCard.offsetHeight - card.offsetHeight - card.offsetTop
            : destCard.offsetTop - card.offsetTop;
        }
      } else {
        // Return siblings smoothly to their resting slots as card drops back
        for (let k = 0; k < dragState.cards.length; k++) {
          if (k !== fromIdx) dragState.cards[k].style.transform = "";
        }
      }

      const willReorder = !canceled && effectiveTarget !== fromIdx && Boolean(editorState.doc);
      const reorderPromise = willReorder && editorState.doc
        ? (() => {
            const currentPages = Array.from({ length: editorState.doc.page_count }, (_, k) => k);
            const [moved] = currentPages.splice(fromIdx, 1);
            currentPages.splice(effectiveTarget, 0, moved);
            return Backend.reorderPages(currentPages);
          })()
        : null;

      this.settlingDrag = true;
      const reduced = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      let settleAnim: Animation | null = null;
      if (!reduced && typeof card.animate === "function") {
        card.classList.add("is-dropping");
        const fromBoxShadow = getComputedStyle(card).boxShadow;
        settleAnim = card.animate(
          [
            {
              transform: `translate3d(0, ${dy}px, 0) scale(${liftScale})`,
              boxShadow: fromBoxShadow,
            },
            {
              transform: `translate3d(0, ${restDy}px, 0) scale(1)`,
              boxShadow: "none",
            },
          ],
          { duration: 220, easing: "cubic-bezier(0.16, 1, 0.3, 1)", fill: "forwards" }
        );
      }

      try {
        const [updated] = await Promise.all([
          reorderPromise,
          settleAnim ? settleAnim.finished.catch(() => undefined) : Promise.resolve(),
        ]);
        try {
          settleAnim?.cancel();
        } catch {
          // Ignore cancel errors
        }
        card.classList.remove("is-dropping");
        this.cleanupDragState(dragState);
        this.settlingDrag = false;

        if (updated) {
          editorState.updateDocument(updated);
          editorState.setCurrentPage(effectiveTarget);
          toast.show({ message: `Moved Page ${fromIdx + 1} to position ${effectiveTarget + 1}`, type: "info" });
        } else {
          this.render();
        }
      } catch (err: any) {
        try {
          settleAnim?.cancel();
        } catch {
          // Ignore cancel errors
        }
        card.classList.remove("is-dropping");
        this.cleanupDragState(dragState);
        this.settlingDrag = false;
        toast.show({ message: `Reorder failed: ${err}`, type: "error" });
        this.render();
      }
    };

    window.addEventListener("pointerup", (e) => void endDrag(e, false), { signal: abort.signal });
    window.addEventListener("pointercancel", (e) => void endDrag(e, true), { signal: abort.signal });
    window.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Escape" && this.dragReorder === dragState) {
          e.preventDefault();
          this.cancelDragReorder();
        }
      },
      { signal: abort.signal }
    );
  }

  private cleanupDragState(dragState: NonNullable<ThumbnailRailView["dragReorder"]>) {
    if (dragState.holdTimer) window.clearTimeout(dragState.holdTimer);
    if (dragState.autoScrollRaf) cancelAnimationFrame(dragState.autoScrollRaf);
    if (dragState.liftAnimRaf) cancelAnimationFrame(dragState.liftAnimRaf);
    dragState.abort.abort();
    dragState.card.classList.remove("is-holding", "is-lifted");
    dragState.card.style.transform = "";
    dragState.container.classList.remove("is-drag-sorting");
    for (const c of dragState.cards) {
      c.style.transform = "";
    }
    this.dragReorder = null;
  }

  private cancelDragReorder() {
    if (this.dragReorder) {
      this.cleanupDragState(this.dragReorder);
    }
  }

  private bindRailEvents() {
    const selMenuBtn = this.element.querySelector<HTMLButtonElement>("#rail-selection-menu");
    const rangePanel = this.element.querySelector<HTMLElement>("#rail-range-panel");
    const rangeInput = this.element.querySelector("#rail-range-input") as HTMLInputElement | null;
    const rangeFeedback = this.element.querySelector<HTMLElement>("#rail-range-feedback");

    const toggleRangeSelector = () => {
      this.rangeExpanded = !this.rangeExpanded;
      if (rangePanel) rangePanel.hidden = !this.rangeExpanded;
      if (this.rangeExpanded) rangeInput?.focus();
    };

    const openSelectionMenu = (event: MouseEvent) => {
      showContextMenu(event, "Page selection", [
        { label: "Select all", icon: CheckSquare, run: () => editorState.selectAllPages() },
        { label: "Invert selection", icon: ArrowLeftRight, run: () => editorState.invertPageSelection() },
        { label: "Clear selection", icon: SquareDashed, run: () => editorState.selectPageRange([]) },
        {
          label: this.rangeExpanded ? "Hide select by range" : "Select by range...",
          icon: SlidersHorizontal,
          separatorBefore: true,
          run: toggleRangeSelector,
        },
      ]);
    };
    selMenuBtn?.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      openSelectionMenu(event);
    });
    selMenuBtn?.addEventListener("click", (event) => {
      if (event.detail === 0) openSelectionMenu(event);
    });

    rangeInput?.addEventListener("input", async () => {
      const val = rangeInput.value.trim();
      if (!val || !editorState.doc) {
        if (rangeFeedback) {
          const count = editorState.selectedPages.size;
          rangeFeedback.textContent = count > 0 ? `${count} selected` : "";
          rangeFeedback.hidden = count === 0;
        }
        return;
      }

      try {
        const matched = await Backend.evaluateRange(val, editorState.doc.page_count);
        if (rangeFeedback) {
          rangeFeedback.hidden = false;
          rangeFeedback.innerHTML = `<span class="text-success font-semibold">${matched.length} page(s) match (${matched.map((p) => p + 1).join(", ")})</span>`;
        }
      } catch (err: any) {
        if (rangeFeedback) {
          rangeFeedback.hidden = false;
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
