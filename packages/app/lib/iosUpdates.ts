// P02 on iPhone: the app comes from TestFlight, which has no in-app check, so
// the newest build is read off the repo's GitHub releases: one `vX.Y.Z` per
// version from 0.23.0 (with every component, the .ipa among them), `ios-vX.Y.Z`
// before that. Each holds the build sent to TestFlight. A release counts once
// it is a day old: TestFlight's external testers get a build only after Beta
// App Review, which lags the GitHub release. At most one request a day,
// cached in localStorage; "later" holds the card back for a day too.

import { isTauri } from "./platform";
import { compareVersions } from "./versions";

export const TESTFLIGHT_URL = "https://testflight.apple.com/join/rV4ktaGv";
export const IOS_RELEASES_URL = "https://api.github.com/repos/zalify/offdesk/releases?per_page=100";
export const IOS_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CACHE_KEY = "offdesk:ios-update";

export const isIosApp = () => isTauri() && typeof navigator !== "undefined" && /iPhone|iPad|iPod/i.test(navigator.userAgent);

export interface IosUpdateCache {
  checkedAt: number;
  /** The newest published iOS version at `checkedAt`, if any. */
  newest: string | null;
  /** The version "later" was pressed on, and when. */
  dismissed?: string;
  dismissedAt?: number;
}

/** How long a release waits before it is offered (see the top). */
export const IOS_RELEASE_SETTLE_MS = 24 * 60 * 60 * 1000;

/** The newest published iOS build in a GitHub releases listing that is at
 * least a day old at `now`: a `vX.Y.Z` release with an .ipa, or an older
 * `ios-vX.Y.Z`. Drafts, pre-releases, other tags (app-v, desktop-v, ui-stable)
 * and Hub-only `v` releases (before 0.23.0) are not iOS builds. */
export function newestIosVersion(releases: unknown, now: number): string | null {
  if (!Array.isArray(releases)) return null;
  let newest: string | null = null;
  for (const release of releases) {
    if (!release || typeof release !== "object") continue;
    const { tag_name: tag, draft, prerelease, published_at: publishedAt, assets } =
      release as { tag_name?: unknown; draft?: unknown; prerelease?: unknown; published_at?: unknown; assets?: unknown };
    if (draft || prerelease || typeof tag !== "string") continue;
    const published = typeof publishedAt === "string" ? Date.parse(publishedAt) : NaN;
    if (!(now - published >= IOS_RELEASE_SETTLE_MS)) continue;
    const match = /^(ios-)?v(\d+\.\d+\.\d+)$/.exec(tag);
    if (!match) continue;
    const hasIpa = Array.isArray(assets) && assets.some((asset) =>
      typeof (asset as { name?: unknown })?.name === "string" && (asset as { name: string }).name.endsWith(".ipa"));
    if (!match[1] && !hasIpa) continue;
    if (newest === null || (compareVersions(match[2], newest) ?? 0) > 0) newest = match[2];
  }
  return newest;
}

/** The version to offer, if `newest` is newer than what is installed. */
export function iosUpdateFor(current: string | null, newest: string | null): string | null {
  if (!current || !newest) return null;
  return (compareVersions(newest, current) ?? 0) > 0 ? newest : null;
}

export const needsIosCheck = (cache: IosUpdateCache | null, now: number) =>
  !cache || now - cache.checkedAt >= IOS_CHECK_INTERVAL_MS || now < cache.checkedAt;

export const isIosUpdateDismissed = (cache: IosUpdateCache | null, version: string, now: number) =>
  cache?.dismissed === version && cache.dismissedAt !== undefined && now - cache.dismissedAt < IOS_CHECK_INTERVAL_MS;

function readCache(): IosUpdateCache | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as IosUpdateCache;
    return typeof parsed?.checkedAt === "number" ? parsed : null;
  } catch {
    return null;
  }
}

function writeCache(cache: IosUpdateCache) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Private mode or full storage: the next launch simply asks again.
  }
}

export interface IosUpdateState {
  current: string | null;
  version: string | null;
}
let state: IosUpdateState = { current: null, version: null };
let checking = false;
const listeners = new Set<() => void>();
export const getIosUpdateState = () => state;
export const subscribeIosUpdates = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
function set(next: IosUpdateState) { state = next; listeners.forEach((listener) => listener()); }

/** Silent by design: a failed check shows nothing and is retried tomorrow. */
export async function checkIosUpdate(
  readCurrent: () => Promise<string> = async () => (await import("@tauri-apps/api/app")).getVersion(),
  fetchReleases: () => Promise<unknown> = async () => {
    const response = await fetch(IOS_RELEASES_URL, { headers: { Accept: "application/vnd.github+json" } });
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    return response.json();
  },
  now = Date.now(),
) {
  if (checking) return;
  checking = true;
  try {
    const current = await readCurrent();
    let cache = readCache();
    if (needsIosCheck(cache, now)) {
      const newest = newestIosVersion(await fetchReleases(), now);
      cache = { ...cache, checkedAt: now, newest };
      writeCache(cache);
    }
    const version = iosUpdateFor(current, cache?.newest ?? null);
    set({ current, version: version && !isIosUpdateDismissed(cache, version, now) ? version : null });
  } catch {
    // Offline, rate-limited, or an app shell without the version API.
  } finally {
    checking = false;
  }
}

export function dismissIosUpdate(now = Date.now()) {
  const { version } = state;
  if (!version) return;
  const cache = readCache() ?? { checkedAt: now, newest: version };
  writeCache({ ...cache, dismissed: version, dismissedAt: now });
  set({ ...state, version: null });
}

export async function openTestFlight() {
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(TESTFLIGHT_URL);
  } catch {
    window.open(TESTFLIGHT_URL, "_blank", "noopener");
  }
}
