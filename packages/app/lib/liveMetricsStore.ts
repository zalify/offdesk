import { useSyncExternalStore } from "react";
import type { ResourceStats } from "@offdesk/shared";

type Listener = () => void;

const rttListeners = new Set<Listener>();
const statsListeners = new Set<Listener>();
const presenceListeners = new Set<Listener>();

let rawRttEwma: number | null = null;
let roundedRttMs: number | null = null;

let machineStats: Record<string, ResourceStats> = {};
let machineStatsPresence: Record<string, boolean> = {};

function notify(listeners: Set<Listener>): void {
  for (const listener of listeners) {
    listener();
  }
}

const NOOP_SUBSCRIBE = () => () => {};
const NULL_SNAPSHOT = () => null;

export function subscribeLiveRtt(listener: Listener): () => void {
  rttListeners.add(listener);
  return () => {
    rttListeners.delete(listener);
  };
}

export function getLiveRttMs(): number | null {
  return roundedRttMs;
}

export function subscribeLiveMachineStats(listener: Listener): () => void {
  statsListeners.add(listener);
  return () => {
    statsListeners.delete(listener);
  };
}

export function getLiveMachineStats(): Record<string, ResourceStats> {
  return machineStats;
}

export function subscribeLiveMachineStatsPresence(listener: Listener): () => void {
  presenceListeners.add(listener);
  return () => {
    presenceListeners.delete(listener);
  };
}

export function getLiveMachineStatsPresence(): Record<string, boolean> {
  return machineStatsPresence;
}

function hasSameKeys(
  a: Record<string, boolean>,
  b: Record<string, boolean>,
): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

/**
 * Record a new WS ping/pong RTT sample (ms). Maintains an EWMA internally
 * and only notifies subscribers when the displayed integer millisecond changes.
 */
export function recordLiveRttSample(sampleMs: number): void {
  if (!Number.isFinite(sampleMs) || sampleMs < 0) return;
  rawRttEwma =
    rawRttEwma === null ? sampleMs : rawRttEwma * 0.7 + sampleMs * 0.3;
  const nextRounded = Math.round(rawRttEwma);
  if (nextRounded === roundedRttMs) return;
  roundedRttMs = nextRounded;
  notify(rttListeners);
}

export function resetLiveRttMs(): void {
  rawRttEwma = null;
  if (roundedRttMs === null) return;
  roundedRttMs = null;
  notify(rttListeners);
}

/**
 * Replace the full machine stats snapshot (e.g. after bootstrap).
 * Presence subscribers are only notified if the set of machines with stats changed.
 */
export function setLiveMachineStatsSnapshot(
  nextStats: Record<string, ResourceStats>,
): void {
  machineStats = nextStats;
  notify(statsListeners);

  const nextPresence: Record<string, boolean> = {};
  for (const machineId of Object.keys(nextStats)) {
    nextPresence[machineId] = true;
  }
  if (!hasSameKeys(machineStatsPresence, nextPresence)) {
    machineStatsPresence = nextPresence;
    notify(presenceListeners);
  }
}

/**
 * Update stats for a single machine. Presence subscribers are only notified
 * when a machine transitions from absent -> present.
 */
export function setLiveMachineStat(
  machineId: string,
  stats: ResourceStats,
): void {
  machineStats = { ...machineStats, [machineId]: stats };
  notify(statsListeners);

  if (!machineStatsPresence[machineId]) {
    machineStatsPresence = { ...machineStatsPresence, [machineId]: true };
    notify(presenceListeners);
  }
}

/**
 * Remove stats for a machine (offline or removed).
 */
export function deleteLiveMachineStat(machineId: string): void {
  if (machineId in machineStats) {
    const nextStats: Record<string, ResourceStats> = {};
    for (const key of Object.keys(machineStats)) {
      if (key !== machineId) nextStats[key] = machineStats[key];
    }
    machineStats = nextStats;
    notify(statsListeners);
  }

  if (machineId in machineStatsPresence) {
    const nextPresence: Record<string, boolean> = {};
    for (const key of Object.keys(machineStatsPresence)) {
      if (key !== machineId) nextPresence[key] = machineStatsPresence[key];
    }
    machineStatsPresence = nextPresence;
    notify(presenceListeners);
  }
}

export function useLiveRttMs(enabled = true): number | null {
  return useSyncExternalStore(
    enabled ? subscribeLiveRtt : NOOP_SUBSCRIBE,
    enabled ? getLiveRttMs : NULL_SNAPSHOT,
    NULL_SNAPSHOT,
  );
}

export function useLiveMachineStats(): Record<string, ResourceStats> {
  return useSyncExternalStore(
    subscribeLiveMachineStats,
    getLiveMachineStats,
    getLiveMachineStats,
  );
}

export function useLiveMachineStatsPresence(): Record<string, boolean> {
  return useSyncExternalStore(
    subscribeLiveMachineStatsPresence,
    getLiveMachineStatsPresence,
    getLiveMachineStatsPresence,
  );
}
