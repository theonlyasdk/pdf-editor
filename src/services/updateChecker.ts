export const GITHUB_RELEASES_API_URL =
  "https://api.github.com/repos/theonlyasdk/pdf-editor/releases/latest";
export const GITHUB_RELEASES_PAGE_URL =
  "https://github.com/theonlyasdk/pdf-editor/releases";

export const UPDATE_CHECK_STORAGE_KEY = "pdf_editor_update_check";
export const AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

declare const __APP_VERSION__: string | undefined;

export const APP_VERSION =
  typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.5.0";

export type UpdateStatus =
  | "idle"
  | "checking"
  | "up-to-date"
  | "update-available"
  | "error";

export interface UpdateCheckResult {
  status: Exclude<UpdateStatus, "idle" | "checking">;
  currentVersion: string;
  latestVersion: string | null;
  releaseUrl: string;
  releaseName: string | null;
  releaseNotes: string | null;
  publishedAt: string | null;
  checkedAt: number;
  error: string | null;
}

interface ParsedSemver {
  parts: number[];
  prerelease: string[];
}

function parseSemver(raw: string): ParsedSemver | null {
  const cleaned = raw.trim().replace(/^v/i, "").split("+")[0];
  if (!cleaned) return null;

  const dashIdx = cleaned.indexOf("-");
  const core = dashIdx === -1 ? cleaned : cleaned.slice(0, dashIdx);
  const pre = dashIdx === -1 ? "" : cleaned.slice(dashIdx + 1);

  const coreSegs = core.split(".");
  if (coreSegs.length === 0 || coreSegs.some((s) => !/^\d+$/.test(s))) {
    return null;
  }

  return {
    parts: coreSegs.map((s) => Number.parseInt(s, 10)),
    prerelease: pre ? pre.split(".").filter(Boolean) : [],
  };
}

/**
 * Returns > 0 if `a` is newer than `b`, < 0 if `a` is older than `b`, or 0 if equal.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);

  if (!pa || !pb) {
    const na = a.trim().replace(/^v/i, "");
    const nb = b.trim().replace(/^v/i, "");
    return na.localeCompare(nb, undefined, { numeric: true, sensitivity: "base" });
  }

  const len = Math.max(pa.parts.length, pb.parts.length);
  for (let i = 0; i < len; i++) {
    const va = pa.parts[i] ?? 0;
    const vb = pb.parts[i] ?? 0;
    if (va !== vb) return va - vb;
  }

  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0;
  if (pa.prerelease.length === 0) return 1;
  if (pb.prerelease.length === 0) return -1;

  const preLen = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < preLen; i++) {
    const ra = pa.prerelease[i];
    const rb = pb.prerelease[i];
    if (ra === undefined) return -1;
    if (rb === undefined) return 1;
    const na = /^\d+$/.test(ra) ? Number.parseInt(ra, 10) : null;
    const nb = /^\d+$/.test(rb) ? Number.parseInt(rb, 10) : null;
    if (na !== null && nb !== null) {
      if (na !== nb) return na - nb;
    } else if (na !== null) {
      return -1;
    } else if (nb !== null) {
      return 1;
    } else {
      const cmp = ra.localeCompare(rb);
      if (cmp !== 0) return cmp;
    }
  }

  return 0;
}

function sanitizeReleaseUrl(url: unknown): string {
  if (typeof url === "string" && url.startsWith("https://")) {
    return url;
  }
  return GITHUB_RELEASES_PAGE_URL;
}

export function loadLastUpdateCheck(): UpdateCheckResult | null {
  try {
    const raw = localStorage.getItem(UPDATE_CHECK_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<UpdateCheckResult>;
    if (
      !parsed ||
      typeof parsed.checkedAt !== "number" ||
      (parsed.status !== "up-to-date" &&
        parsed.status !== "update-available" &&
        parsed.status !== "error")
    ) {
      return null;
    }
    return {
      status: parsed.status,
      currentVersion:
        typeof parsed.currentVersion === "string" ? parsed.currentVersion : APP_VERSION,
      latestVersion:
        typeof parsed.latestVersion === "string" ? parsed.latestVersion : null,
      releaseUrl: sanitizeReleaseUrl(parsed.releaseUrl),
      releaseName: typeof parsed.releaseName === "string" ? parsed.releaseName : null,
      releaseNotes:
        typeof parsed.releaseNotes === "string" ? parsed.releaseNotes : null,
      publishedAt: typeof parsed.publishedAt === "string" ? parsed.publishedAt : null,
      checkedAt: parsed.checkedAt,
      error: typeof parsed.error === "string" ? parsed.error : null,
    };
  } catch {
    return null;
  }
}

export function saveLastUpdateCheck(result: UpdateCheckResult): void {
  try {
    localStorage.setItem(UPDATE_CHECK_STORAGE_KEY, JSON.stringify(result));
  } catch {
    // Ignore storage errors (e.g. private/restricted environments)
  }
}

export function shouldAutoCheckForUpdates(
  autoCheckEnabled: boolean,
  now = Date.now(),
  lastCheck: UpdateCheckResult | null = loadLastUpdateCheck()
): boolean {
  if (!autoCheckEnabled) return false;
  if (!lastCheck) return true;
  if (lastCheck.status === "error") {
    return now - lastCheck.checkedAt >= AUTO_CHECK_INTERVAL_MS;
  }
  return now - lastCheck.checkedAt >= AUTO_CHECK_INTERVAL_MS;
}

export interface CheckForUpdatesOptions {
  currentVersion?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  endpoint?: string;
}

export async function checkForUpdates(
  options: CheckForUpdatesOptions = {}
): Promise<UpdateCheckResult> {
  const currentVersion = options.currentVersion ?? APP_VERSION;
  const fetchFn = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const endpoint = options.endpoint ?? GITHUB_RELEASES_API_URL;
  const checkedAt = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(endpoint, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
      },
      signal: controller.signal,
    });

    if (response.status === 404) {
      const result: UpdateCheckResult = {
        status: "up-to-date",
        currentVersion,
        latestVersion: currentVersion,
        releaseUrl: GITHUB_RELEASES_PAGE_URL,
        releaseName: null,
        releaseNotes: null,
        publishedAt: null,
        checkedAt,
        error: null,
      };
      saveLastUpdateCheck(result);
      return result;
    }

    if (!response.ok) {
      const message =
        response.status === 403 || response.status === 429
          ? "GitHub API rate limit reached. Try again later."
          : `Update server returned HTTP ${response.status}.`;
      const result: UpdateCheckResult = {
        status: "error",
        currentVersion,
        latestVersion: null,
        releaseUrl: GITHUB_RELEASES_PAGE_URL,
        releaseName: null,
        releaseNotes: null,
        publishedAt: null,
        checkedAt,
        error: message,
      };
      saveLastUpdateCheck(result);
      return result;
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const rawTag = typeof payload.tag_name === "string" ? payload.tag_name.trim() : "";
    if (!rawTag) {
      const result: UpdateCheckResult = {
        status: "error",
        currentVersion,
        latestVersion: null,
        releaseUrl: GITHUB_RELEASES_PAGE_URL,
        releaseName: null,
        releaseNotes: null,
        publishedAt: null,
        checkedAt,
        error: "Release metadata did not include a version tag.",
      };
      saveLastUpdateCheck(result);
      return result;
    }

    const latestVersion = rawTag.replace(/^v/i, "");
    const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;
    const result: UpdateCheckResult = {
      status: hasUpdate ? "update-available" : "up-to-date",
      currentVersion,
      latestVersion,
      releaseUrl: sanitizeReleaseUrl(payload.html_url),
      releaseName: typeof payload.name === "string" && payload.name.trim() ? payload.name.trim() : null,
      releaseNotes: typeof payload.body === "string" && payload.body.trim() ? payload.body.trim() : null,
      publishedAt: typeof payload.published_at === "string" ? payload.published_at : null,
      checkedAt,
      error: null,
    };
    saveLastUpdateCheck(result);
    return result;
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    const errorMsg = isAbort
      ? "Update check timed out. Check your internet connection."
      : err instanceof Error && err.message
        ? err.message
        : "Could not reach update server.";
    const result: UpdateCheckResult = {
      status: "error",
      currentVersion,
      latestVersion: null,
      releaseUrl: GITHUB_RELEASES_PAGE_URL,
      releaseName: null,
      releaseNotes: null,
      publishedAt: null,
      checkedAt,
      error: errorMsg,
    };
    saveLastUpdateCheck(result);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

export function formatLastChecked(checkedAt: number | null | undefined, now = Date.now()): string {
  if (!checkedAt || !Number.isFinite(checkedAt)) return "Never checked";
  const diffMs = Math.max(0, now - checkedAt);
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hr ago`;
  return new Date(checkedAt).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
