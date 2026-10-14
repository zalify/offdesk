import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IOS_CHECK_INTERVAL_MS, iosUpdateFor, isIosUpdateDismissed, needsIosCheck, newestIosVersion,
} from "./iosUpdates";

// Shaped like https://api.github.com/repos/zalify/offdesk/releases on 2026-10-14.
const releases = [
  { tag_name: "rc-ios-0.7.1-rc.1-3a1fa85", draft: true, prerelease: false },
  { tag_name: "ios-v0.9.0", draft: false, prerelease: false },
  { tag_name: "desktop-v0.9.0", draft: false, prerelease: false },
  { tag_name: "app-v0.9.1", draft: false, prerelease: false },
  { tag_name: "ui-stable-38502574171-1", draft: false, prerelease: true },
  { tag_name: "v0.22.0", draft: false, prerelease: false },
  { tag_name: "ios-v0.8.0", draft: false, prerelease: false },
  { tag_name: "ios-v0.10.0", draft: true, prerelease: false },
  { tag_name: "ios-v0.11.0-rc.1", draft: false, prerelease: true },
];

describe("iOS update source", () => {
  it("picks the newest published ios-v release and nothing else", () => {
    expect(newestIosVersion(releases)).toBe("0.9.0");
    expect(newestIosVersion([...releases, { tag_name: "ios-v0.9.10" }])).toBe("0.9.10");
    expect(newestIosVersion({ message: "API rate limit exceeded" })).toBeNull();
    expect(newestIosVersion([])).toBeNull();
  });
  it("offers only a newer build than the installed one", () => {
    expect(iosUpdateFor("0.8.0", "0.9.0")).toBe("0.9.0");
    expect(iosUpdateFor("0.9.0", "0.9.0")).toBeNull();
    expect(iosUpdateFor("0.9.1", "0.9.0")).toBeNull();
    expect(iosUpdateFor(null, "0.9.0")).toBeNull();
    expect(iosUpdateFor("0.9.0", null)).toBeNull();
  });
  it("asks GitHub at most once a day", () => {
    const now = 1_800_000_000_000;
    expect(needsIosCheck(null, now)).toBe(true);
    expect(needsIosCheck({ checkedAt: now - 1000, newest: null }, now)).toBe(false);
    expect(needsIosCheck({ checkedAt: now - IOS_CHECK_INTERVAL_MS, newest: null }, now)).toBe(true);
    // A clock set back does not freeze the check forever.
    expect(needsIosCheck({ checkedAt: now + 1000, newest: null }, now)).toBe(true);
  });
  it("keeps a dismissed version quiet for a day, and a newer one is new", () => {
    const now = 1_800_000_000_000;
    const cache = { checkedAt: now, newest: "0.9.0", dismissed: "0.9.0", dismissedAt: now - 1000 };
    expect(isIosUpdateDismissed(cache, "0.9.0", now)).toBe(true);
    expect(isIosUpdateDismissed(cache, "0.9.1", now)).toBe(false);
    expect(isIosUpdateDismissed(cache, "0.9.0", now - 1000 + IOS_CHECK_INTERVAL_MS)).toBe(false);
  });
});

describe("iOS update check", () => {
  let store: Map<string, string>;
  beforeEach(() => {
    vi.resetModules();
    store = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("caches the answer and serves the next launch from it", async () => {
    const updates = await import("./iosUpdates");
    const fetchReleases = vi.fn().mockResolvedValue(releases);
    const now = 1_800_000_000_000;
    await updates.checkIosUpdate(async () => "0.8.0", fetchReleases, now);
    expect(updates.getIosUpdateState()).toEqual({ current: "0.8.0", version: "0.9.0" });
    await updates.checkIosUpdate(async () => "0.8.0", fetchReleases, now + 60_000);
    expect(fetchReleases).toHaveBeenCalledTimes(1);
  });
  it("hides the card after later, until the day is out", async () => {
    const updates = await import("./iosUpdates");
    const now = 1_800_000_000_000;
    await updates.checkIosUpdate(async () => "0.8.0", async () => releases, now);
    updates.dismissIosUpdate(now);
    expect(updates.getIosUpdateState().version).toBeNull();
    await updates.checkIosUpdate(async () => "0.8.0", async () => releases, now + 60_000);
    expect(updates.getIosUpdateState().version).toBeNull();
    await updates.checkIosUpdate(async () => "0.8.0", async () => releases, now + IOS_CHECK_INTERVAL_MS);
    expect(updates.getIosUpdateState().version).toBe("0.9.0");
  });
  it("stays silent when GitHub cannot be reached", async () => {
    const updates = await import("./iosUpdates");
    await updates.checkIosUpdate(async () => "0.8.0", async () => { throw new Error("offline"); });
    expect(updates.getIosUpdateState()).toEqual({ current: null, version: null });
  });
  it("works without storage at all", async () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } });
    const updates = await import("./iosUpdates");
    await updates.checkIosUpdate(async () => "0.8.0", async () => releases);
    expect(updates.getIosUpdateState().version).toBe("0.9.0");
  });
});
