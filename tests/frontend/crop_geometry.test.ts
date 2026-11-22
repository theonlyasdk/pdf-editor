import { describe, expect, it } from "vitest";
import { resizeCrop } from "../../src/components/cropGeometry";

const page = { width: 600, height: 800 };
const box = { x: 0, y: 0, ...page };

describe("crop handles", () => {
  it("keeps the bottom-right anchor as the top-left handle moves", () => {
    expect(resizeCrop(box, "nw", 40, 60, page)).toEqual({ x: 40, y: 60, width: 560, height: 740 });
  });

  it("projects fixed-ratio corner drags continuously across the diagonal", () => {
    const first = resizeCrop(box, "nw", 100, 99.9, page, 0.75);
    const second = resizeCrop(box, "nw", 100, 100.1, page, 0.75);
    expect(Math.abs(first.x - second.x)).toBeLessThan(1);
    expect(first.width / first.height).toBeCloseTo(0.75);
    expect(first.x + first.width).toEqual(600);
    expect(first.y + first.height).toEqual(800);
  });
});
