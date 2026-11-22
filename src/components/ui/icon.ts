import { createElement } from "lucide";

export function icon(node: Parameters<typeof createElement>[0], size = 16): string {
  return createElement(node, {
    width: size,
    height: size,
    "aria-hidden": "true",
    focusable: "false",
  }).outerHTML;
}
