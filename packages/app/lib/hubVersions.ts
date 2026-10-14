// What the hub says about versions (GET /api/version and
// /api/machines/versions, hub 0.23+), for Settings › versions and the phone
// panel on a node. Two numbering lines that are never compared: the desktop
// app (0.9.x, lib/desktopUpdate.ts) and the hub, node and CLI (0.23.x, here).

import { useEffect, useSyncExternalStore } from "react";

import { ApiError, getHubVersion, getMachineVersions, type HubVersionInfo as HubVersion, type MachineVersionInfo as MachineVersion } from "./api";

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

/** What the desktop app ships, on the hub machine (lib/bundledServices.ts). */
export interface Bundled {
  hub_version: string | null;
  node_version: string | null;
  machine_id: string | null;
}

/** How many parts are behind: the desktop app (when an update for it is
 *  available), the hub (the interface follows it, so it is not counted
 *  again), and each node. On the hub machine a bundled part running
 *  something other than what the app ships counts too. */
export function partsBehind(appUpdate: string | null, hub: HubAnswer | null, nodes: MachineVersion[] | null, bundled: Bundled | null = null): number {
  const running = hub?.kind === "known" ? hub.version.hub : null;
  const hubStale = !!bundled?.hub_version && running !== bundled.hub_version;
  const nodeStale = (node: MachineVersion) =>
    !!bundled?.node_version && node.id === bundled.machine_id && node.version !== bundled.node_version;
  return (appUpdate ? 1 : 0) + (hubBehind(hub) || hubStale ? 1 : 0) + (nodes ?? []).filter((node) => node.update_available || nodeStale(node)).length;
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
// An answer that didn't come is asked for once more, 30 s later.
let retry: ReturnType<typeof setTimeout> | null = null;
let retried = false;

/** Nothing came back about the hub or its nodes: worth asking again. */
export function needsRetry(current: Pick<VersionsState, "hub" | "nodes">): boolean {
  return current.hub?.kind === "unknown" || (current.hub?.kind === "known" && current.nodes === null);
}

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
    if (!needsRetry(state)) retried = false;
    else if (!retried && !retry) {
      retried = true;
      retry = setTimeout(() => {
        retry = null;
        void refreshVersions();
      }, 30_000);
    }
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** The hub's answer; asks once when nobody has yet. */
export function useVersions(): VersionsState {
  useEffect(() => {
    if (state.hub === null) void refreshVersions();
    // Back at the window after the hub was unreachable: ask again.
    const focus = () => {
      if (needsRetry(state)) void refreshVersions();
    };
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
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

/** How a row reads for a part this app bundles (the hub and node on the hub
 *  machine). Red only when the running part isn't the bundled version — a
 *  restart that hasn't happened. A newer release that no app ships yet is
 *  news, not a fault: the latest column shows it in the accent and the part
 *  comes with the next app update. */
export function bundledPart(
  running: string | null,
  bundled: string | null,
  updateAvailable: boolean,
  appUpdate: boolean,
): { red: boolean; newer: boolean; action: "with the app" | "restarts at next launch" | "comes with the next app update" | "current" } {
  const red = bundled ? running !== bundled : updateAvailable;
  const newer = !red && updateAvailable;
  if (appUpdate) return { red, newer, action: "with the app" };
  // The app restarts its services onto the bundled binaries at launch.
  if (red) return { red, newer, action: "restarts at next launch" };
  return { red, newer, action: newer ? "comes with the next app update" : "current" };
}
