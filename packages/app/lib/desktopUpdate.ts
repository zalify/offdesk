// The desktop app's own update (the Tauri updater): checked a few seconds
// after launch, downloaded in the background, then offered as a restart by
// the card above the status line (components/UpdateNotification.tsx), the
// status line's `↑ update`, Settings › versions, and the menu bar item,
// which hears about it through `app_update_state` (src-tauri/src/tray.rs).
// The shell keeps whether a new bundle is installed, so a reloaded window
// picks up where it was. Its numbers (0.9.x) are the app's; the hub's
// (0.23.x) live in versions.ts.

import { useSyncExternalStore } from "react";
import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater";

import { detectOS } from "./platform";

export type UpdatePhase = "idle" | "downloading" | "ready" | "installing" | "installed";

export interface DesktopUpdateState {
  /** This app's version; null until known. */
  current: string | null;
  /** The newer version the updater offers. */
  available: string | null;
  phase: UpdatePhase;
  /** A check is running. It never changes `phase` until it has an answer. */
  checking: boolean;
  /** Share of the download done, 0–1, when its size is known. */
  progress: number | null;
  /** The last failure, in words. */
  error: string | null;
  /** "You’re up to date." after a check someone asked for. */
  message: string | null;
  checkedAt: number | null;
  /** `when I quit` where nothing can install before it: hidden until next launch. */
  deferred: boolean;
  /** Asked for (status line, Settings): shown even when dismissed. */
  cardOpen: boolean;
  /** The card's ×: this version stays out of the way until `until`. */
  dismissed: { version: string; until: number } | null;
}

const DISMISSED_KEY = "offdesk:desktop-update-dismissed";
export const RESTART_TO_FINISH = "Installed. Restart Offdesk DEV to finish.";

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
 *  so `when I quit` can install now and the next start is the new version.
 *  Windows' installer closes the app, so there it waits for the next launch. */
export function installsBeforeQuit(os: ReturnType<typeof detectOS>): boolean {
  return os === "macos" || os === "linux";
}

/** What a finished check does to the state: nothing changes under a card
 *  that is showing, and an installed bundle stays installed. */
export function afterCheck(
  state: Pick<DesktopUpdateState, "phase" | "available">,
  offered: string | null,
  downloaded: boolean,
): "keep" | "none" | "download" {
  if (state.phase === "installed") return "keep";
  if (!offered) return "none";
  return offered === state.available && state.phase === "ready" && downloaded ? "keep" : "download";
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
  checking: false,
  progress: null,
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

// The updater's handle on the offered version and whether its bytes are here.
let pending: Update | null = null;
let downloaded = false;

async function dropPending() {
  const old = pending;
  pending = null;
  downloaded = false;
  await old?.close().catch(() => {});
}

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

/** The menu bar item mirrors this: a `restart to update` item and a dot. */
async function tellShell(version: string | null, installed: boolean) {
  await invoke("app_update_state", { version, installed }).catch(() => {});
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

// A reloaded window: the shell knows whether a new bundle is in place.
let restored: Promise<void> | null = null;
export function restoreDesktopUpdate(): Promise<void> {
  restored ??= (async () => {
    const [current, shell] = await Promise.all([
      readAppVersion(),
      invoke<{ version: string | null; installed: boolean }>("app_update_status").catch(() => null),
    ]);
    publish({ current: state.current ?? current });
    if (shell?.installed && shell.version) publish({ phase: "installed", available: shell.version });
  })();
  return restored;
}

// One check (and its download) at a time; whoever comes next waits for it.
let running: Promise<void> | null = null;
async function settled() {
  await restoreDesktopUpdate();
  while (running) await running.catch(() => {});
}

/** Ask the updater; download what it offers so `restart now` is quick.
 *  `silent` keeps "up to date" and failures out of sight (the launch and
 *  periodic checks). What is showing stays as it is while it runs. */
export async function checkDesktopUpdate({ silent = false }: { silent?: boolean } = {}): Promise<void> {
  await settled();
  if (state.phase === "installing") return;
  running = check(silent).finally(() => {
    running = null;
  });
  return running;
}

async function check(silent: boolean): Promise<void> {
  publish({ checking: true, error: null, message: null });
  try {
    const updater = await import("@tauri-apps/plugin-updater");
    const update = await updater.check();
    const checkedAt = Date.now();
    const next = afterCheck(state, update?.version ?? null, downloaded);
    if (next === "keep") {
      await update?.close().catch(() => {});
      publish({ checkedAt });
      return;
    }
    if (next === "none" || !update) {
      await dropPending();
      publish({ available: null, phase: "idle", message: silent ? null : "You’re up to date.", checkedAt });
      void tellShell(null, false);
      return;
    }
    await dropPending();
    pending = update;
    publish({ available: update.version, current: update.currentVersion || state.current, phase: "downloading", progress: null, checkedAt });
    await download(update);
    publish({ phase: "ready", progress: null });
    void tellShell(update.version, false);
  } catch (error) {
    // What is downloaded or installed stays; an offer whose download failed
    // stands too, and `restart to update` downloads it again.
    if (state.phase === "downloading") publish({ phase: "idle", progress: null });
    if (!silent) publish({ error: `Could not check for updates: ${String(error)}` });
  } finally {
    publish({ checking: false });
  }
}

async function download(update: Update) {
  let total = 0;
  let done = 0;
  await update.download((event: DownloadEvent) => {
    if (event.event === "Started") total = event.data.contentLength ?? 0;
    if (event.event === "Progress" && total > 0) {
      done += event.data.chunkLength;
      publish({ progress: Math.min(1, done / total) });
    }
  });
  downloaded = true;
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
      void tellShell(null, false);
      return false;
    }
    publish({ available: pending.version });
  }
  if (!downloaded) await download(pending);
  await pending.install();
  // install() released the bytes; the bundle on disk is the new version.
  downloaded = false;
  await tellShell(pending.version, true);
  return true;
}

async function relaunchOrSay() {
  try {
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
    // Still here: the new version is in place for the next start.
    publish({ phase: "installed" });
  } catch {
    publish({ phase: "installed", error: RESTART_TO_FINISH, cardOpen: true });
  }
}

/** `restart now`: install and relaunch. On the hub machine the next launch
 *  restarts the hub and node onto the new bundled binaries
 *  (src-tauri/src/bundled_services.rs). */
export async function restartToUpdate(): Promise<void> {
  await settled();
  if (state.phase === "installing") return;
  const before = state.phase;
  publish({ phase: "installing", error: null, message: null });
  if (before !== "installed") {
    try {
      if (!(await install())) return;
    } catch (error) {
      publish({ phase: downloaded ? "ready" : "idle", error: `Update failed. You can try again: ${String(error)}` });
      return;
    }
  }
  await relaunchOrSay();
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
