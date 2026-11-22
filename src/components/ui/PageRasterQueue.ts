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
  private observer: IntersectionObserver;

  constructor(root: HTMLElement) {
    this.observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const job = this.jobs.get(entry.target);
        if (job) {
          job.visible = entry.isIntersecting;
          job.frame.toggleAttribute("data-raster-visible", job.visible);
        }
      }
      void this.drain();
    }, { root, rootMargin: "160px 0px" });
  }

  reset() {
    this.observer.disconnect();
    this.jobs.clear();
  }

  add(frame: HTMLElement, image: HTMLImageElement, page: number, width: number) {
    frame.dataset.raster = "loading";
    this.jobs.set(frame, { frame, image, page, width, visible: false });
    this.observer.observe(frame);
  }

  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const job = [...this.jobs.values()].find(({ visible }) => visible);
        if (!job) break;
        this.jobs.delete(job.frame);
        this.observer.unobserve(job.frame);
        try {
          const url = await Backend.renderPage(job.page, job.width);
          if (!job.frame.isConnected) continue;
          job.image.src = url;
          await job.image.decode();
          job.frame.dataset.raster = "ready";
        } catch (error) {
          if (!job.frame.isConnected) continue;
          job.frame.dataset.raster = "error";
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
