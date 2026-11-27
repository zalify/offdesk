import { useSyncExternalStore } from "react";

export const SIDEBAR_HOVER_SPACE_KEY = "offdesk:sidebar-hover-switch-space";
export const SIDEBAR_HOVER_TERMINAL_KEY = "offdesk:sidebar-hover-switch-terminal";
export const SIDEBAR_HOVER_PREFERENCES_CHANGED =
  "offdesk:sidebar-hover-preferences-changed";

export interface SidebarHoverPreferences {
  hoverSwitchSpace: boolean;
  hoverSwitchTerminal: boolean;
}

const DEFAULT_PREFERENCES: SidebarHoverPreferences = {
  hoverSwitchSpace: true,
  hoverSwitchTerminal: true,
};

function parseBool(raw: string | null | undefined, fallback: boolean): boolean {
  if (raw === "0" || raw === "false") return false;
  if (raw === "1" || raw === "true") return true;
  return fallback;
}

function defaultStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readSidebarHoverPreferences(
  storage: Pick<Storage, "getItem"> | null = defaultStorage(),
): SidebarHoverPreferences {
  try {
    return {
      hoverSwitchSpace: parseBool(
        storage?.getItem(SIDEBAR_HOVER_SPACE_KEY),
        DEFAULT_PREFERENCES.hoverSwitchSpace,
      ),
      hoverSwitchTerminal: parseBool(
        storage?.getItem(SIDEBAR_HOVER_TERMINAL_KEY),
        DEFAULT_PREFERENCES.hoverSwitchTerminal,
      ),
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

let cachedSnapshot: SidebarHoverPreferences = DEFAULT_PREFERENCES;

function getSnapshot(): SidebarHoverPreferences {
  const next = readSidebarHoverPreferences();
  if (
    cachedSnapshot.hoverSwitchSpace === next.hoverSwitchSpace &&
    cachedSnapshot.hoverSwitchTerminal === next.hoverSwitchTerminal
  ) {
    return cachedSnapshot;
  }
  cachedSnapshot = next;
  return cachedSnapshot;
}

function getServerSnapshot(): SidebarHoverPreferences {
  return DEFAULT_PREFERENCES;
}

export function writeSidebarHoverPreferences(
  patch: Partial<SidebarHoverPreferences>,
  storage: Pick<Storage, "getItem" | "setItem"> | null = defaultStorage(),
): SidebarHoverPreferences {
  try {
    if (patch.hoverSwitchSpace !== undefined) {
      storage?.setItem(
        SIDEBAR_HOVER_SPACE_KEY,
        patch.hoverSwitchSpace ? "1" : "0",
      );
    }
    if (patch.hoverSwitchTerminal !== undefined) {
      storage?.setItem(
        SIDEBAR_HOVER_TERMINAL_KEY,
        patch.hoverSwitchTerminal ? "1" : "0",
      );
    }
  } catch {
    /* ignore storage write failures */
  }
  const next = readSidebarHoverPreferences(storage);
  if (
    cachedSnapshot.hoverSwitchSpace !== next.hoverSwitchSpace ||
    cachedSnapshot.hoverSwitchTerminal !== next.hoverSwitchTerminal
  ) {
    cachedSnapshot = next;
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(SIDEBAR_HOVER_PREFERENCES_CHANGED));
  }
  return next;
}

export function subscribeSidebarHoverPreferences(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event: StorageEvent) => {
    if (
      event.key === null ||
      event.key === SIDEBAR_HOVER_SPACE_KEY ||
      event.key === SIDEBAR_HOVER_TERMINAL_KEY
    ) {
      listener();
    }
  };
  window.addEventListener(SIDEBAR_HOVER_PREFERENCES_CHANGED, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(SIDEBAR_HOVER_PREFERENCES_CHANGED, listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useSidebarHoverPreferences(): SidebarHoverPreferences {
  return useSyncExternalStore(
    subscribeSidebarHoverPreferences,
    getSnapshot,
    getServerSnapshot,
  );
}
