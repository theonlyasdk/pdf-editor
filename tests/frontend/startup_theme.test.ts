import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const bootstrap = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];

function resolveTheme(saved: string | null, systemDark: boolean, storageBlocked = false) {
  const dataset: { theme?: string } = {};
  runInNewContext(bootstrap!, {
    document: { documentElement: { dataset } },
    localStorage: {
      getItem(key: string) {
        expect(key).toBe("pdf_editor_theme");
        if (storageBlocked) throw new Error("Storage unavailable");
        return saved;
      },
    },
    matchMedia: () => ({ matches: systemDark }),
  });
  return dataset.theme;
}

describe("first-paint theme", () => {
  it("runs before the application stylesheet", () => {
    expect(bootstrap).toBeDefined();
    expect(html.indexOf("<script>")).toBeLessThan(html.indexOf('rel="stylesheet"'));
  });

  it("honors saved choices even when the OS theme differs", () => {
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
  });

  it("follows the OS on first launch or when storage is unavailable", () => {
    expect(resolveTheme(null, true)).toBe("dark");
    expect(resolveTheme(null, false)).toBe("light");
    expect(resolveTheme("invalid", true)).toBe("dark");
    expect(resolveTheme(null, true, true)).toBe("dark");
  });
});
