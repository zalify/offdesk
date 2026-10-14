// The desktop app's own update (the Tauri updater): checked a few seconds
// after launch, downloaded in the background, then offered as a restart by
// the card above the status line (components/UpdateNotification.tsx), the
// status line's `↑ update`, Settings › versions, and the menu bar item,
// which hears about it through `app_update_state` (src-tauri/src/tray.rs).
// Its numbers (0.9.x) are the app's; the hub's (0.23.x) live in versions.ts.

import { useSyncExternalStore } from "react";
import type { Update } from "@tauri-apps/plugin-updater";

import { detectOS } from "./platform";

export type UpdatePhase = "idle" | "checking" | "downloading" | "ready" | "installing" | "installed";

export interface DesktopUpdateState {
  /** This app's version; null until known. */
  current: string | null;
  /** The newer version the updater offers. */
  available: string | null;
  phase: UpdatePhase;
  /** The last failure, in words. */
  error: string | null;
  /** "You’re up to date." after a check someone asked for. */
  message: string | null;
  checkedAt: number | null;
  /** `when I quit` where nothing can install on quit: hidden until the next launch. */
  deferred: boolean;
  /** Asked for (status line, Settings): shown even when dismissed. */
  cardOpen: boolean;
  /** The card's ×: this version stays out of the way until `until`. */
  dismissed: { version: string; until: number } | null;
}

const DISMISSED_KEY = "offdesk:desktop-update-dismissed";

/** Local midnight after `now`: "until tomorrow". */
export function startOfNextDay(now: number): number {
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);
  return next.getTime();
}

/** Whether the floating card shows: an update is downloaded (or being
 *  installed from the card), and nobody put it off — unless someone asked
 *  for it, which wins over both. */
export function cardVisible(state: DesktopUpdateState, now: number): boolean {
  if (!state.available) return false;
  if (state.cardOpen) return true;
  if (state.phase !== "ready" && state.phase !== "installing") return false;
  if (state.deferred) return false;
  const dismissed = state.dismissed;
  return !(dismissed && dismissed.version === state.available && now < dismissed.until);
}

/** macOS and Linux replace the app in place and keep running the old one,
 *  so `when I quit` can install now and let the quit finish it. Windows'
 *  installer closes the app, so there it can only wait for the next launch. */
export function installsBeforeQuit(os: ReturnType<typeof detectOS>): boolean {
  return os === "macos" || os === "linux";
}

function readDismissed(): DesktopUpdateState["dismissed"] {
  try {
    const raw = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? "null");
    return raw && typeof raw.version === "string" && typeof raw.until === "number" ? raw : null;
  } catch {
    return null;
  }
}

let state: DesktopUpdateState = {
  current: null,
  available: null,
  phase: "idle",
  error: null,
  message: null,
  checkedAt: null,
  deferred: false,
  cardOpen: false,
  dismissed: typeof localStorage === "undefined" ? null : readDismissed(),
};
const listeners = new Set<() => void>();
const publish = (patch: Partial<DesktopUpdateState>) => {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const getDesktopUpdateState = () => state;
export const useDesktopUpdate = () => useSyncExternalStore(subscribe, getDesktopUpdateState, getDesktopUpdateState);

// The updater's handle on the offered version, whether its bytes are here,
// and whether any version has replaced the bundle under the running app.
let pending: Update | null = null;
let downloaded = false;
let bundleReplaced = false;

async function dropPending() {
  const old = pending;
  pending = null;
  downloaded = false;
  await old?.close().catch(() => {});
}

/** The menu bar item mirrors this: a `restart to update` item and a dot. */
async function tellShell(version: string | null, installed: boolean) {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("app_update_state", { version, installed });
  } catch {
    /* an older shell has no menu item to update */
  }
}

// Direct __TAURI_INTERNALS__ invoke, as Settings › about does: Metro's
// dynamic import of @tauri-apps/api has been seen to resolve without
// reaching the native side.
async function readAppVersion(): Promise<string | null> {
  const internals = (window as unknown as { __TAURI_INTERNALS__?: { invoke: <T>(cmd: string) => Promise<T> } }).__TAURI_INTERNALS__;
  try {
    return (await internals?.invoke<string>("plugin:app|version")) ?? null;
  } catch {
    return null;
  }
}

// One check (and its download) at a time; whoever comes next waits for it.
let running: Promise<void> | null = null;
async function settled() {
  while (running) await running.catch(() => {});
}

/** Ask the updater; download what it offers so `restart now` is quick.
 *  `silent` keeps "up to date" and failures out of sight (the launch check). */
export async function checkDesktopUpdate({ silent = false }: { silent?: boolean } = {}): Promise<void> {
  await settled();
  if (state.phase === "installing") return;
  running = check(silent).finally(() => {
    running = null;
  });
  return running;
}

async function check(silent: boolean): Promise<void> {
  const before = state.phase;
  publish({ phase: "checking", error: null, message: null });
  if (!state.current) publish({ current: await readAppVersion() });
  let update: Update | null = null;
  try {
    const updater = await import("@tauri-apps/plugin-updater");
    update = await updater.check();
    const checkedAt = Date.now();
    if (!update) {
      await dropPending();
      publish({ available: null, phase: "idle", message: silent ? null : "You’re up to date.", checkedAt });
      void tellShell(null, bundleReplaced);
      return;
    }
    if (update.version === state.available && (before === "installed" || (before === "ready" && downloaded))) {
      // Already here; the running app is just still the old one.
      await update.close().catch(() => {});
      publish({ phase: before, checkedAt });
      return;
    }
    await dropPending();
    pending = update;
    publish({ available: update.version, current: update.currentVersion || state.current, phase: "downloading", checkedAt });
    await update.download();
    downloaded = true;
    publish({ phase: "ready" });
    void tellShell(update.version, bundleReplaced);
  } catch (error) {
    // What is already downloaded or installed stays; an offer whose download
    // failed stands too, and `restart to update` downloads it again.
    const kept = before === "installed" || (before === "ready" && downloaded) ? before : "idle";
    publish({ phase: kept, error: silent ? null : `Could not check for updates: ${String(error)}` });
  }
}

/** Download if needed and install the offered version. False when there
 *  turned out to be nothing to install. */
async function install(): Promise<boolean> {
  if (!pending) {
    const updater = await import("@tauri-apps/plugin-updater");
    pending = await updater.check();
    downloaded = false;
    // Another installation may already have picked it up.
    if (!pending) {
      publish({ available: null, phase: "idle", message: "You’re up to date." });
      void tellShell(null, bundleReplaced);
      return false;
    }
    publish({ available: pending.version });
  }
  if (!downloaded) {
    await pending.download();
    downloaded = true;
  }
  await pending.install();
  // install() released the bytes; the bundle on disk is the new version.
  downloaded = false;
  bundleReplaced = true;
  await tellShell(pending.version, true);
  return true;
}

/** `restart now`: install and relaunch. On the hub machine the shell's exit
 *  hook restarts the hub and node onto the new bundled binaries. */
export async function restartToUpdate(): Promise<void> {
  await settled();
  if (state.phase === "installing") return;
  const before = state.phase;
  publish({ phase: "installing", error: null, message: null });
  try {
    if (before !== "installed" && !(await install())) return;
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
    // Still here: the new version is in place for the next start.
    publish({ phase: "installed" });
  } catch (error) {
    publish({ phase: downloaded ? "ready" : before === "installed" ? "installed" : "idle", error: `Update failed. You can try again: ${String(error)}` });
  }
}

/** `when I quit`: install now where the running app survives it, so the next
 *  start is the new version; elsewhere, out of the way until next launch. */
export async function updateWhenQuitting(): Promise<void> {
  await settled();
  if (state.phase === "installing") return;
  if (!installsBeforeQuit(detectOS())) {
    publish({ deferred: true, cardOpen: false });
    return;
  }
  const before = state.phase;
  publish({ phase: "installing", error: null, message: null });
  try {
    if (before === "installed" || (await install())) publish({ phase: "installed", cardOpen: false });
  } catch (error) {
    publish({ phase: downloaded ? "ready" : "idle", error: `Update failed. You can try again: ${String(error)}` });
  }
}

/** The card's ×: until tomorrow, for this version. */
export function dismissUntilTomorrow(now = Date.now()): void {
  if (!state.available) return;
  const dismissed = { version: state.available, until: startOfNextDay(now) };
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(dismissed));
  } catch {
    /* private mode: it still hides for this session */
  }
  publish({ dismissed, cardOpen: false });
}

export const openUpdateCard = () => publish({ cardOpen: true });
export const closeUpdateCard = () => publish({ cardOpen: false });
