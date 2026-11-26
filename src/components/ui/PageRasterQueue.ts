import { Backend, isRenderCancelledError } from "../../ipc/backend";

export type RasterTarget = HTMLCanvasElement | HTMLImageElement;

export interface PageGeometry {
  inViewport: boolean;
  inMargin: boolean;
  dist: number;
}

export interface PageRasterQueueOptions {
  isPriorityPage?: (page: number) => boolean;
  shouldPreloadAll?: () => boolean;
  getPageGeometry?: (page: number, frame: HTMLElement) => PageGeometry | null;
}

interface PageJob {
  frame: HTMLElement;
  target: RasterTarget;
  page: number;
  width: number;
  visible: boolean;
}

export class PageRasterQueue {
  private static nextQueueId = 1;
  private readonly queueId = PageRasterQueue.nextQueueId++;
  private jobs = new Map<Element, PageJob>();
  private activeWorkers = 0;
  private activePriorityWorkers = 0;
  private activeHighResWorkers = 0;
  private maxConcurrency: number;
  private latest = new WeakMap<Element, PageJob>();
  private observer: IntersectionObserver;
  private root: HTMLElement;
  private options: PageRasterQueueOptions;
  private generation = 0;

  constructor(root: HTMLElement, maxConcurrency = 4, options: PageRasterQueueOptions = {}) {
    this.root = root;
    this.maxConcurrency = Math.max(1, maxConcurrency);
    this.options = options;
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const job = this.latest.get(entry.target);
          if (job) {
            job.visible = entry.isIntersecting;
            job.frame.toggleAttribute("data-raster-visible", job.visible);
          }
        }
        this.drain();
      },
      { root, rootMargin: "200px" },
    );
  }

  reset() {
    this.generation++;
    this.observer.disconnect();
    this.jobs.clear();
    this.latest = new WeakMap();
  }

  bumpGeneration(): number {
    return ++this.generation;
  }

  triggerDrain() {
    this.drain();
  }

  evict(frame: HTMLElement) {
    this.observer.unobserve(frame);
    const prev = this.latest.get(frame);
    this.latest.delete(frame);
    this.jobs.delete(frame);
    if (prev) {
      if (prev.target instanceof HTMLCanvasElement) {
        prev.target.width = 0;
        prev.target.height = 0;
      } else if (prev.target instanceof HTMLImageElement) {
        const blobUrl = prev.target.dataset.blobUrl;
        if (blobUrl) {
          URL.revokeObjectURL(blobUrl);
          delete prev.target.dataset.blobUrl;
        }
        prev.target.removeAttribute("src");
      }
    }
    delete frame.dataset.raster;
    delete frame.dataset.request;
    delete frame.dataset.renderedPixels;
    frame.removeAttribute("data-raster-visible");
    frame.querySelector(".page-raster-retry")?.remove();
  }

  add(frame: HTMLElement, target: RasterTarget, page: number, width: number) {
    const previous = this.latest.get(frame);
    if (frame.dataset.raster !== "ready") frame.dataset.raster = "loading";

    const isPriority = Boolean(this.options.isPriorityPage?.(page));
    let visible = Boolean(previous?.visible || isPriority);
    if (!visible) {
      const geom = this.options.getPageGeometry?.(page, frame);
      if (geom) {
        visible = geom.inMargin;
      } else {
        const rootRect = this.root.getBoundingClientRect();
        const frameRect = frame.getBoundingClientRect();
        const margin = 200;
        visible =
          rootRect.height > 0 &&
          rootRect.width > 0 &&
          frameRect.width > 0 &&
          frameRect.height > 0 &&
          frameRect.bottom >= rootRect.top - margin &&
          frameRect.top <= rootRect.bottom + margin &&
          frameRect.right >= rootRect.left - margin &&
          frameRect.left <= rootRect.right + margin;
      }
    }

    const job: PageJob = {
      frame,
      target,
      page,
      width,
      visible,
    };
    this.latest.set(frame, job);
    this.jobs.set(frame, job);
    frame.querySelector(".page-raster-retry")?.remove();
    if (!previous) {
      this.observer.observe(frame);
    }
    if (visible || this.options.shouldPreloadAll?.()) {
      this.drain();
    }
  }

  private pickNextJob(): { job: PageJob; isPriority: boolean } | undefined {
    const getGeom = this.options.getPageGeometry;
    const rootRect = getGeom ? null : this.root.getBoundingClientRect();
    const centerX = rootRect ? (rootRect.left + rootRect.right) / 2 : 0;
    const centerY = rootRect ? (rootRect.top + rootRect.bottom) / 2 : 0;
    const preloadAll = Boolean(this.options.shouldPreloadAll?.());
    const hasViewport = rootRect ? rootRect.height > 0 && rootRect.width > 0 : true;

    let best: PageJob | undefined;
    let bestTier = Infinity;
    let bestDist = Infinity;
    let bestIsPriority = false;

    for (const [el, job] of this.jobs) {
      if (!job.frame.isConnected || this.latest.get(el) !== job) {
        this.jobs.delete(el);
        continue;
      }

      const isPriority = Boolean(this.options.isPriorityPage?.(job.page));
      let inViewport: boolean;
      let dist: number;

      const geom = getGeom?.(job.page, job.frame);
      if (geom) {
        inViewport = geom.inViewport;
        dist = geom.dist;
      } else {
        const r = job.frame.getBoundingClientRect();
        inViewport =
          hasViewport &&
          rootRect !== null &&
          r.width > 0 &&
          r.height > 0 &&
          r.bottom >= rootRect.top &&
          r.top <= rootRect.bottom &&
          r.right >= rootRect.left &&
          r.left <= rootRect.right;
        dist =
          r.width > 0 && r.height > 0
            ? Math.hypot(r.left + r.width / 2 - centerX, r.top + r.height / 2 - centerY)
            : job.page;
      }

      let tier: number;
      if (isPriority) {
        tier = 0;
      } else if (inViewport) {
        tier = 1;
      } else if (job.visible) {
        tier = 2;
      } else if (preloadAll) {
        tier = 3;
      } else {
        continue;
      }

      if (tier < bestTier || (tier === bestTier && dist < bestDist)) {
        best = job;
        bestTier = tier;
        bestDist = dist;
        bestIsPriority = isPriority;
        if (tier === 0 && dist === 0) break;
      }
    }

    if (!best) return undefined;
    // Keep off-screen prefetch/background jobs out of the pool while the priority page is rendering.
    if (bestTier >= 2 && this.activePriorityWorkers > 0) {
      return undefined;
    }
    // Cap concurrent high-resolution renders (>= 1800px) to 2 to avoid memory spikes.
    if (best.width >= 1800 && this.activeHighResWorkers >= 2 && bestTier > 0) {
      return undefined;
    }

    this.jobs.delete(best.frame);
    return { job: best, isPriority: bestIsPriority };
  }

  private drain() {
    while (this.activeWorkers < this.maxConcurrency) {
      const picked = this.pickNextJob();
      if (!picked) break;
      const { job, isPriority } = picked;
      const isHighRes = job.width >= 1800;
      this.activeWorkers++;
      if (isPriority) this.activePriorityWorkers++;
      if (isHighRes) this.activeHighResWorkers++;
      void this.runJob(job).finally(() => {
        this.activeWorkers--;
        if (isPriority) this.activePriorityWorkers--;
        if (isHighRes) this.activeHighResWorkers--;
        this.drain();
      });
    }
  }

  private async runJob(job: PageJob) {
    try {
      if (!job.frame.isConnected || this.latest.get(job.frame) !== job) return;

      if (job.target instanceof HTMLCanvasElement) {
        const buf = await Backend.renderPageRaw(job.page, job.width, {
          generation: this.generation,
          queueId: this.queueId,
        });
        if (!job.frame.isConnected || this.latest.get(job.frame) !== job) return;
        const view = new DataView(buf);
        const w = view.getUint32(0, true);
        const h = view.getUint32(4, true);
        const pixels = new Uint8ClampedArray(buf, 8, w * h * 4);
        const imageData = new ImageData(pixels, w, h);

        if (job.target.width !== w) job.target.width = w;
        if (job.target.height !== h) job.target.height = h;
        const ctx = job.target.getContext("2d", { alpha: false });
        if (ctx) {
          ctx.putImageData(imageData, 0, 0);
        }
      } else {
        const url = await Backend.renderPage(job.page, job.width);
        const replacement = new Image();
        replacement.src = url;
        await replacement.decode();
        if (!job.frame.isConnected || this.latest.get(job.frame) !== job) {
          if (url.startsWith("blob:")) URL.revokeObjectURL(url);
          return;
        }
        const prevBlob = job.target.dataset.blobUrl;
        if (prevBlob && prevBlob !== url) URL.revokeObjectURL(prevBlob);
        if (url.startsWith("blob:")) job.target.dataset.blobUrl = url;
        job.target.src = url;
      }

      job.frame.dataset.raster = "ready";
      job.frame.dataset.renderedPixels = String(job.width);
      job.frame.dispatchEvent(new Event("page-raster-ready"));
    } catch (error) {
      if (!job.frame.isConnected || this.latest.get(job.frame) !== job) return;
      if (isRenderCancelledError(error)) return;
      if (job.frame.dataset.raster !== "ready") job.frame.dataset.raster = "error";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "ui-button ui-button--outline ui-button--sm page-raster-retry";
      retry.textContent = "Retry page";
      retry.title = String(error);
      retry.addEventListener("click", (event) => {
        event.stopPropagation();
        retry.remove();
        this.add(job.frame, job.target, job.page, job.width);
      });
      job.frame.appendChild(retry);
      console.error(`Page ${job.page + 1} could not be rendered`, error);
    }
  }
}
