// The hub machine's services as the desktop shell found them at launch
// (src-tauri/src/bundled_services.rs): whether they run from this app, the
// versions it ships, which it restarted onto them, and what went wrong.
// The check runs in the background after launch, so this asks until it has
// finished.

import { useEffect, useSyncExternalStore } from "react";

import { isDesktopShell } from "./desktopHub";

export interface BundledServices {
  done: boolean;
  /** The hub service runs the hub inside this app, so it updates with it. */
  bundled: boolean;
  hub_version: string | null;
  node_version: string | null;
  /** This machine's node id, to find its row among the hub's machines. */
  machine_id: string | null;
  restarted: string[];
  /** "couldn't restart the hub: …" */
  error: string | null;
}

let state: BundledServices | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const snapshot = () => state;
let polling = false;

async function poll() {
  if (polling || !isDesktopShell()) return;
  polling = true;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    for (let tries = 0; tries < 60; tries++) {
      const next = await invoke<BundledServices>("bundled_services").catch(() => null);
      if (!next) return;
      if (next.done) {
        state = next;
        listeners.forEach((listener) => listener());
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  } finally {
    polling = false;
  }
}

/** null until the shell has finished looking (and outside the desktop app). */
export function useBundledServices(): BundledServices | null {
  useEffect(() => {
    if (!state) void poll();
  }, []);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
