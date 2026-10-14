// What the hub says about versions (GET /api/version and
// /api/machines/versions, hub 0.23+), for Settings › versions and the phone
// panel on a node. Two numbering lines that are never compared: the desktop
// app (0.9.x, lib/desktopUpdate.ts) and the hub, node and CLI (0.23.x, here).

import { useEffect, useSyncExternalStore } from "react";

import { ApiError, getHubVersion, getMachineVersions, type HubVersion, type MachineVersion } from "./api";

/** A hub before 0.23 has no version endpoints: that is an answer — it is
 *  older than 0.23 — never an error that breaks a screen. */
export function isOlderHub(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.status === 405);
}

export type HubAnswer =
  | { kind: "known"; version: HubVersion }
  | { kind: "older" }
  /** Not reachable, or it answered something else: say nothing about it. */
  | { kind: "unknown" };

export interface VersionsState {
  /** null until the first answer. */
  hub: HubAnswer | null;
  /** Online nodes; null when the hub can't say (older, or unreachable). */
  nodes: MachineVersion[] | null;
  checking: boolean;
  checkedAt: number | null;
}

export const OLDER_THAN_REPORTING = "older than 0.23";

export function hubBehind(hub: HubAnswer | null): boolean {
  return hub?.kind === "older" || (hub?.kind === "known" && hub.version.update_available);
}

/** The hub's newest release, when it knows one. */
export function latestRelease(hub: HubAnswer | null): string | null {
  return hub?.kind === "known" ? hub.version.latest : null;
}

/** How many parts are behind: the desktop app (when an update for it is
 *  available), the hub (the interface follows it, so it is not counted
 *  again), and each node. */
export function partsBehind(appUpdate: string | null, hub: HubAnswer | null, nodes: MachineVersion[] | null): number {
  return (appUpdate ? 1 : 0) + (hubBehind(hub) ? 1 : 0) + (nodes ?? []).filter((node) => node.update_available).length;
}

/** The phone panel's warning on a node, or null when the hub is current
 *  (or can't be asked). */
export function hubWarning(hub: HubAnswer | null, hubName: string): string | null {
  if (hub?.kind === "older") return `${hubName}'s hub is ${OLDER_THAN_REPORTING}`;
  if (hub?.kind === "known" && hub.version.update_available && hub.version.latest) {
    return `${hubName}'s hub is ${hub.version.hub}, ${hub.version.latest} is out`;
  }
  return null;
}

/** "just now", "2 minutes ago", "3 hours ago". */
export function checkedAgo(checkedAt: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - checkedAt) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"} ago`;
}

let state: VersionsState = { hub: null, nodes: null, checking: false, checkedAt: null };
const listeners = new Set<() => void>();
const publish = (patch: Partial<VersionsState>) => {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const snapshot = () => state;

let inflight: Promise<void> | null = null;

/** Ask the hub again. Concurrent callers share one round trip. */
export function refreshVersions(): Promise<void> {
  if (inflight) return inflight;
  publish({ checking: true });
  inflight = (async () => {
    const [hub, nodes] = await Promise.allSettled([getHubVersion(), getMachineVersions()]);
    publish({
      hub: hub.status === "fulfilled" && hub.value?.hub
        ? { kind: "known", version: hub.value }
        : hub.status === "rejected" && isOlderHub(hub.reason) ? { kind: "older" } : { kind: "unknown" },
      nodes: nodes.status === "fulfilled" && Array.isArray(nodes.value) ? nodes.value : null,
      checking: false,
      checkedAt: Date.now(),
    });
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** The hub's answer; asks once when nobody has yet. */
export function useVersions(): VersionsState {
  useEffect(() => {
    if (state.hub === null) void refreshVersions();
  }, []);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** "mac-mini.local" from "http://mac-mini.local:4317": how the screens name
 *  a hub they know only by its address. */
export function hostOf(address: string): string {
  try {
    return new URL(address).hostname.replace(/^\[(.*)\]$/, "$1") || address;
  } catch {
    return address;
  }
}
