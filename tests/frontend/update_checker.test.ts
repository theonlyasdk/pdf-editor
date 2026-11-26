import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTO_CHECK_INTERVAL_MS,
  checkForUpdates,
  compareVersions,
  formatLastChecked,
  GITHUB_RELEASES_PAGE_URL,
  loadLastUpdateCheck,
  shouldAutoCheckForUpdates,
  UPDATE_CHECK_STORAGE_KEY,
} from "../../src/services/updateChecker";

function createMemoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
  };
}

describe("updateChecker", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createMemoryStorage());
  });

  it("compares semantic versions accurately", () => {
    expect(compareVersions("0.5.0", "0.4.0")).toBeGreaterThan(0);
    expect(compareVersions("v0.10.0", "0.4.0")).toBeGreaterThan(0);
    expect(compareVersions("0.4.1", "0.4.0")).toBeGreaterThan(0);
    expect(compareVersions("0.4.0", "v0.4.0")).toBe(0);
    expect(compareVersions("0.3.9", "0.4.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0-beta.2", "1.0.0-beta.1")).toBeGreaterThan(0);
  });

  it("reports update-available when GitHub latest release is newer", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          tag_name: "v0.5.0",
          name: "PDF Editor 0.5.0",
          html_url: "https://github.com/theonlyasdk/pdf-editor/releases/tag/v0.5.0",
          body: "Added auto-update checker",
          published_at: "2026-11-26T00:00:00Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    ) as unknown as typeof fetch;

    const result = await checkForUpdates({
      currentVersion: "0.4.0",
      fetchImpl: fetchMock,
    });

    expect(result.status).toBe("update-available");
    expect(result.latestVersion).toBe("0.5.0");
    expect(result.releaseUrl).toBe(
      "https://github.com/theonlyasdk/pdf-editor/releases/tag/v0.5.0"
    );
    expect(result.releaseName).toBe("PDF Editor 0.5.0");
    expect(result.error).toBeNull();
    expect(loadLastUpdateCheck()?.latestVersion).toBe("0.5.0");
  });

  it("reports up-to-date when current version matches or exceeds latest", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          tag_name: "v0.4.0",
          html_url: "https://github.com/theonlyasdk/pdf-editor/releases/tag/v0.4.0",
        }),
        { status: 200 }
      )
    ) as unknown as typeof fetch;

    const result = await checkForUpdates({
      currentVersion: "0.4.0",
      fetchImpl: fetchMock,
    });

    expect(result.status).toBe("up-to-date");
    expect(result.latestVersion).toBe("0.4.0");
    expect(result.error).toBeNull();
  });

  it("treats 404 (no published releases) as up-to-date", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 })) as unknown as typeof fetch;

    const result = await checkForUpdates({
      currentVersion: "0.4.0",
      fetchImpl: fetchMock,
    });

    expect(result.status).toBe("up-to-date");
    expect(result.releaseUrl).toBe(GITHUB_RELEASES_PAGE_URL);
  });

  it("handles rate limits, network errors, and non-https release URLs safely", async () => {
    const rateLimitedFetch = vi.fn(async () => new Response(null, { status: 403 })) as unknown as typeof fetch;
    const rateResult = await checkForUpdates({
      currentVersion: "0.4.0",
      fetchImpl: rateLimitedFetch,
    });
    expect(rateResult.status).toBe("error");
    expect(rateResult.error).toContain("rate limit");

    const networkFetch = vi.fn(async () => {
      throw new Error("Network offline");
    }) as unknown as typeof fetch;
    const netResult = await checkForUpdates({
      currentVersion: "0.4.0",
      fetchImpl: networkFetch,
    });
    expect(netResult.status).toBe("error");
    expect(netResult.error).toBe("Network offline");

    const unsafeUrlFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          tag_name: "v0.5.0",
          html_url: "javascript:alert(1)",
        }),
        { status: 200 }
      )
    ) as unknown as typeof fetch;
    const safeResult = await checkForUpdates({
      currentVersion: "0.4.0",
      fetchImpl: unsafeUrlFetch,
    });
    expect(safeResult.status).toBe("update-available");
    expect(safeResult.releaseUrl).toBe(GITHUB_RELEASES_PAGE_URL);
  });

  it("throttles automatic startup checks based on preference and interval", () => {
    const now = 1_700_000_000_000;
    expect(shouldAutoCheckForUpdates(false, now, null)).toBe(false);
    expect(shouldAutoCheckForUpdates(true, now, null)).toBe(true);

    localStorage.setItem(
      UPDATE_CHECK_STORAGE_KEY,
      JSON.stringify({
        status: "up-to-date",
        currentVersion: "0.4.0",
        latestVersion: "0.4.0",
        releaseUrl: GITHUB_RELEASES_PAGE_URL,
        releaseName: null,
        releaseNotes: null,
        publishedAt: null,
        checkedAt: now - 60_000,
        error: null,
      })
    );

    expect(shouldAutoCheckForUpdates(true, now)).toBe(false);
    expect(shouldAutoCheckForUpdates(true, now + AUTO_CHECK_INTERVAL_MS)).toBe(true);
  });

  it("formats last checked timestamps cleanly", () => {
    const now = 1_700_000_000_000;
    expect(formatLastChecked(null, now)).toBe("Never checked");
    expect(formatLastChecked(now - 10_000, now)).toBe("Just now");
    expect(formatLastChecked(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(formatLastChecked(now - 3 * 3600_000, now)).toBe("3 hr ago");
  });
});
