import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { editorState } from "../../src/state/editorState";
import { Backend } from "../../src/ipc/backend";
import { PageRasterQueue } from "../../src/components/ui/PageRasterQueue";
import { DocumentDto } from "../../src/types/editor";

describe("Per-page raster keys and concurrent PageRasterQueue", () => {
  const baseDoc: DocumentDto = {
    file_path: "/dummy/perf.pdf",
    file_name: "perf.pdf",
    page_count: 3,
    pages: [
      { index: 0, width: 612, height: 792, rotation: 0, media_box: { x: 0, y: 0, width: 612, height: 792 } },
      { index: 1, width: 612, height: 792, rotation: 0, media_box: { x: 0, y: 0, width: 612, height: 792 } },
      { index: 2, width: 612, height: 792, rotation: 0, media_box: { x: 0, y: 0, width: 612, height: 792 } },
    ],
    metadata: { page_count: 3, file_size_bytes: 1024, is_encrypted: false },
    can_undo: false,
    can_redo: false,
    is_dirty: false,
    revision_id: 1,
    page_revisions: [101, 201, 301],
  };

  beforeEach(() => {
    editorState.setDocument(baseDoc);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("changes getPageRasterKey only for pages whose token updated", () => {
    const k0 = editorState.getPageRasterKey(0);
    const k1 = editorState.getPageRasterKey(1);
    const k2 = editorState.getPageRasterKey(2);

    editorState.updateDocument({
      ...baseDoc,
      revision_id: 2,
      page_revisions: [101, 202, 301],
    });

    expect(editorState.getPageRasterKey(0)).toBe(k0);
    expect(editorState.getPageRasterKey(1)).not.toBe(k1);
    expect(editorState.getPageRasterKey(2)).toBe(k2);
  });

  it("falls back to rasterVersion when page_revisions is omitted", () => {
    const { page_revisions: _omit, ...legacyDoc } = baseDoc;
    editorState.setDocument(legacyDoc);
    const before = editorState.getPageRasterKey(0);
    editorState.updateDocument({ ...legacyDoc, revision_id: 2 });
    expect(editorState.getPageRasterKey(0)).not.toBe(before);
  });

  it("runs multiple PageRasterQueue jobs concurrently and releases canvas memory on evict", async () => {
    type ObserverCb = (entries: Array<{ target: Element; isIntersecting: boolean }>) => void;
    let observerCb: ObserverCb | null = null;

    class MockIntersectionObserver {
      constructor(cb: ObserverCb) {
        observerCb = cb;
      }
      observe(el: Element) {
        observerCb?.([{ target: el, isIntersecting: true }]);
      }
      unobserve() {}
      disconnect() {}
    }

    class MockImageData {
      data: Uint8ClampedArray;
      width: number;
      height: number;
      constructor(data: Uint8ClampedArray, width: number, height: number) {
        this.data = data;
        this.width = width;
        this.height = height;
      }
    }

    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
    vi.stubGlobal("ImageData", MockImageData);

    const makeFrame = (top: number) => {
      const ctx = { putImageData: vi.fn(), drawImage: vi.fn() };
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => ctx,
      } as unknown as HTMLCanvasElement;
      // Make `instanceof HTMLCanvasElement` true in Node test environment
      vi.stubGlobal("HTMLCanvasElement", canvas.constructor);
      vi.stubGlobal("HTMLImageElement", class {});

      const frame = {
        isConnected: true,
        dataset: {} as Record<string, string>,
        toggleAttribute: vi.fn(),
        removeAttribute: vi.fn(),
        querySelector: () => null,
        appendChild: vi.fn(),
        dispatchEvent: vi.fn(),
        getBoundingClientRect: () => ({ top, height: 100 }),
      } as unknown as HTMLElement;
      return { frame, canvas, ctx };
    };

    const root = {
      getBoundingClientRect: () => ({ top: 0, bottom: 500 }),
    } as unknown as HTMLElement;

    let inFlight = 0;
    let maxInFlight = 0;
    const resolvers: Array<() => void> = [];

    const makeRgbaPayload = () => {
      const buf = new ArrayBuffer(8 + 4 * 4);
      const view = new DataView(buf);
      view.setUint32(0, 2, true);
      view.setUint32(4, 2, true);
      return buf;
    };

    vi.spyOn(Backend, "renderPageRaw").mockImplementation(
      () =>
        new Promise<ArrayBuffer>((resolve) => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          resolvers.push(() => {
            inFlight--;
            resolve(makeRgbaPayload());
          });
        }),
    );

    const queue = new PageRasterQueue(root, 3);
    const items = [makeFrame(0), makeFrame(120), makeFrame(240), makeFrame(360)];
    items.forEach((item, idx) => queue.add(item.frame, item.canvas, idx, 800));

    expect(maxInFlight).toBe(3);

    while (resolvers.length > 0) {
      resolvers.shift()!();
      await Promise.resolve();
      await Promise.resolve();
    }
    await new Promise((r) => setTimeout(r, 10));

    for (const item of items) {
      expect(item.canvas.width).toBe(2);
      expect(item.canvas.height).toBe(2);
      expect(item.frame.dataset.raster).toBe("ready");
    }

    queue.evict(items[0].frame);
    expect(items[0].canvas.width).toBe(0);
    expect(items[0].canvas.height).toBe(0);
    expect(items[0].frame.dataset.raster).toBeUndefined();
  });

  it("prioritizes current page ahead of other pages and supports preloadAll", async () => {
    type ObserverCb = (entries: Array<{ target: Element; isIntersecting: boolean }>) => void;
    let observerCb: ObserverCb | null = null;
    class MockIntersectionObserver {
      constructor(cb: ObserverCb) {
        observerCb = cb;
      }
      observe(el: Element) {
        const idx = Number((el as HTMLElement).dataset.idx);
        observerCb?.([{ target: el, isIntersecting: idx < 3 }]);
      }
      unobserve() {}
      disconnect() {}
    }
    class MockImageData {
      constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
    }
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
    vi.stubGlobal("ImageData", MockImageData);

    const order: number[] = [];
    const makePayload = () => {
      const buf = new ArrayBuffer(8 + 16);
      const view = new DataView(buf);
      view.setUint32(0, 2, true);
      view.setUint32(4, 2, true);
      return buf;
    };
    vi.spyOn(Backend, "renderPageRaw").mockImplementation(async (page) => {
      order.push(page);
      return makePayload();
    });

    const ctx = { putImageData: vi.fn() };
    const makeCanvas = () => ({ width: 0, height: 0, getContext: () => ctx }) as unknown as HTMLCanvasElement;
    const sampleCanvas = makeCanvas();
    vi.stubGlobal("HTMLCanvasElement", sampleCanvas.constructor);
    vi.stubGlobal("HTMLImageElement", class {});

    const root = {
      getBoundingClientRect: () => ({ left: 0, right: 800, width: 800, top: 0, bottom: 500, height: 500 }),
    } as unknown as HTMLElement;

    const makeFrame = (idx: number, top: number) =>
      ({
        isConnected: true,
        dataset: { idx: String(idx) } as Record<string, string>,
        toggleAttribute: vi.fn(),
        removeAttribute: vi.fn(),
        querySelector: () => null,
        appendChild: vi.fn(),
        dispatchEvent: vi.fn(),
        getBoundingClientRect: () => ({ left: 0, right: 600, width: 600, top, bottom: top + 100, height: 100 }),
      }) as unknown as HTMLElement;

    let preload = true;
    const queue = new PageRasterQueue(root, 1, {
      isPriorityPage: (page) => page === 2,
      shouldPreloadAll: () => preload,
    });

    // Add page 0, 1 (in viewport), 3 (off-screen), then priority page 2 last
    queue.add(makeFrame(0, 10), makeCanvas(), 0, 800);
    queue.add(makeFrame(1, 120), makeCanvas(), 1, 800);
    queue.add(makeFrame(3, 1200), makeCanvas(), 3, 800);
    queue.add(makeFrame(2, 240), makeCanvas(), 2, 800);

    await new Promise((r) => setTimeout(r, 20));
    expect(order[0]).toBe(0); // First synchronous drain on add(0)
    expect(order[1]).toBe(2); // Priority page jumps ahead of queued page 1 & off-screen page 3
    expect(order).toContain(3); // Off-screen page preloaded when preloadAll is true

    order.length = 0;
    preload = false;
    queue.add(makeFrame(4, 1400), makeCanvas(), 4, 800);
    await new Promise((r) => setTimeout(r, 15));
    expect(order).toEqual([]); // Off-screen page not loaded when preloadAll is false
  });
});
