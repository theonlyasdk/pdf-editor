import type { PageBox } from "../types/editor";

export function resizeCrop(
  box: PageBox,
  handle: string,
  dx: number,
  dy: number,
  page: Pick<PageBox, "width" | "height">,
  ratio?: number,
): PageBox {
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  if (handle === "move") {
    return {
      ...box,
      x: clamp(box.x + dx, 0, page.width - box.width),
      y: clamp(box.y + dy, 0, page.height - box.height),
    };
  }

  const horizontal = handle.includes("w") ? -1 : Number(handle.includes("e"));
  const vertical = handle.includes("n") ? -1 : Number(handle.includes("s"));
  const anchorX = box.x + (horizontal < 0 ? box.width : horizontal === 0 ? box.width / 2 : 0);
  const anchorY = box.y + (vertical < 0 ? box.height : vertical === 0 ? box.height / 2 : 0);
  const maxWidth = horizontal < 0 ? anchorX : horizontal > 0 ? page.width - anchorX : page.width;
  const maxHeight = vertical < 0 ? anchorY : vertical > 0 ? page.height - anchorY : page.height;
  let width = horizontal ? clamp(box.width + horizontal * dx, Math.min(box.width, 24), maxWidth) : box.width;
  let height = vertical ? clamp(box.height + vertical * dy, Math.min(box.height, 24), maxHeight) : box.height;

  if (ratio) {
    // Project a corner's pointer onto the aspect-ratio diagonal so changing direction
    // doesn't switch between competing width and height calculations.
    const projected = horizontal && vertical
      ? ((box.width + horizontal * dx) * ratio + box.height + vertical * dy) / (ratio * ratio + 1)
      : horizontal ? width / ratio : height;
    const upper = Math.min(maxHeight, maxWidth / ratio);
    const lower = Math.min(box.height, box.width / ratio, Math.max(24, 24 / ratio), upper);
    height = clamp(projected, lower, upper);
    width = height * ratio;
  }

  return {
    x: horizontal < 0 ? anchorX - width : horizontal > 0 ? anchorX : clamp(anchorX - width / 2, 0, page.width - width),
    y: vertical < 0 ? anchorY - height : vertical > 0 ? anchorY : clamp(anchorY - height / 2, 0, page.height - height),
    width,
    height,
  };
}
