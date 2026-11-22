import { Backend } from "../../ipc/backend";

interface PageJob {
  frame: HTMLElement;
  image: HTMLImageElement;
  page: number;
  width: number;
  visible: boolean;
}

export class PageRasterQueue {
  private jobs = new Map<Element, PageJob>();
  private running = false;
  private latest = new WeakMap<Element, PageJob>();
  private observer: IntersectionObserver;

  constructor(root: HTMLElement) {
    this.observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const job = this.latest.get(entry.target);
        if (job) {
          job.visible = entry.isIntersecting;
          job.frame.toggleAttribute("data-raster-visible", job.visible);
        }
      }
      void this.drain();
    }, { root, rootMargin: "160px" });
  }

  reset() {
    this.observer.disconnect();
    this.jobs.clear();
    this.latest = new WeakMap();
  }

  add(frame: HTMLElement, image: HTMLImageElement, page: number, width: number) {
    const previous = this.latest.get(frame);
    if (frame.dataset.raster !== "ready") frame.dataset.raster = "loading";
    const job = { frame, image, page, width, visible: previous?.visible ?? false };
    this.latest.set(frame, job);
    this.jobs.set(frame, job);
    frame.querySelector(".page-raster-retry")?.remove();
    this.observer.unobserve(frame);
    this.observer.observe(frame);
    if (job.visible) void this.drain();
  }

  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const job = [...this.jobs.values()].find(({ visible }) => visible);
        if (!job) break;
        this.jobs.delete(job.frame);
        try {
          const url = await Backend.renderPage(job.page, job.width);
          const replacement = new Image();
          replacement.src = url;
          await replacement.decode();
          if (!job.frame.isConnected || this.latest.get(job.frame) !== job) continue;
          job.image.src = url;
          job.frame.dataset.raster = "ready";
          job.frame.dispatchEvent(new Event("page-raster-ready"));
        } catch (error) {
          if (!job.frame.isConnected || this.latest.get(job.frame) !== job) continue;
          if (job.frame.dataset.raster !== "ready") job.frame.dataset.raster = "error";
          const retry = document.createElement("button");
          retry.type = "button";
          retry.className = "ui-button ui-button--outline ui-button--sm page-raster-retry";
          retry.textContent = "Retry page";
          retry.title = String(error);
          retry.addEventListener("click", (event) => {
            event.stopPropagation();
            retry.remove();
            this.add(job.frame, job.image, job.page, job.width);
          });
          job.frame.appendChild(retry);
          console.error(`Page ${job.page + 1} could not be rendered`, error);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
