// Single prefix-key shortcut engine. The app steals exactly one key from the
// terminal — Ctrl+B — and every other key passes through to the pty/browser.
// `⌃B ⌃B` sends a literal Ctrl+B (byte 0x02) to the focused terminal.
// Identical on macOS and Linux: metaKey is never used for app actions.
// Pure logic, no DOM — see
// docs/superpowers/specs/2026-07-18-raw-terminal-ux-redesign-design.md §6.

export const PREFIX_BINDINGS_STORAGE_KEY = "offdesk:prefix-bindings";

export type PrefixActionId =
  | "newTerminal"
  | "selectTab1"
  | "selectTab2"
  | "selectTab3"
  | "selectTab4"
  | "selectTab5"
  | "selectTab6"
  | "selectTab7"
  | "selectTab8"
  | "selectTab9"
  | "nextTab"
  | "prevTab"
  | "sessionSwitcher"
  | "splitRight"
  | "splitDown"
  | "rotateLayout"
  | "equalizePanes"
  | "paneLeft"
  | "paneRight"
  | "paneUp"
  | "paneDown"
  | "zoomPane"
  | "closePane"
  | "copyMode"
  | "switchHost"
  | "commandPalette"
  | "cheatSheet";

// Bindings map an action to a single `KeyboardEvent.key` value — no
// modifiers except the implicit Shift a symbol needs (e.g. "%" = Shift+5).
export type PrefixBindings = Record<PrefixActionId, string>;

export type PrefixResult =
  | { type: "pass" } // not ours: let terminal/browser have it
  | { type: "arm" } // Ctrl+B pressed: swallow, enter armed state
  | { type: "disarm" } // Esc while armed: swallow, exit armed
  | { type: "literal" } // ⌃B ⌃B: swallow, caller sends \x02 to pty
  | { type: "action"; action: PrefixActionId } // swallow, run action
  | { type: "swallow" }; // armed + unbound key: swallow, disarm

export interface PrefixKeyEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export const DEFAULT_PREFIX_BINDINGS: PrefixBindings = {
  newTerminal: "c",
  selectTab1: "1",
  selectTab2: "2",
  selectTab3: "3",
  selectTab4: "4",
  selectTab5: "5",
  selectTab6: "6",
  selectTab7: "7",
  selectTab8: "8",
  selectTab9: "9",
  nextTab: "n",
  prevTab: "p",
  sessionSwitcher: "w",
  splitRight: "%",
  splitDown: '"',
  rotateLayout: "r",
  equalizePanes: "E",
  paneLeft: "ArrowLeft",
  paneRight: "ArrowRight",
  paneUp: "ArrowUp",
  paneDown: "ArrowDown",
  zoomPane: "z",
  closePane: "x",
  copyMode: "[",
  switchHost: "s",
  commandPalette: "k",
  cheatSheet: "?",
};

export const PREFIX_ACTION_DEFINITIONS: Array<{
  id: PrefixActionId;
  label: string;
  // Actions wired in later phases: dispatch is a no-op stub for now and the
  // cheat sheet filters them out.
  comingSoon?: boolean;
}> = [
  { id: "newTerminal", label: "New terminal" },
  { id: "selectTab1", label: "Switch to tab 1" },
  { id: "selectTab2", label: "Switch to tab 2" },
  { id: "selectTab3", label: "Switch to tab 3" },
  { id: "selectTab4", label: "Switch to tab 4" },
  { id: "selectTab5", label: "Switch to tab 5" },
  { id: "selectTab6", label: "Switch to tab 6" },
  { id: "selectTab7", label: "Switch to tab 7" },
  { id: "selectTab8", label: "Switch to tab 8" },
  { id: "selectTab9", label: "Switch to tab 9" },
  { id: "nextTab", label: "Next tab" },
  { id: "prevTab", label: "Previous tab" },
  { id: "sessionSwitcher", label: "Session switcher" },
  { id: "splitRight", label: "Split pane right" },
  { id: "splitDown", label: "Split pane down" },
  { id: "rotateLayout", label: "Rotate layout" },
  { id: "equalizePanes", label: "Equalize panes" },
  { id: "paneLeft", label: "Focus pane left" },
  { id: "paneRight", label: "Focus pane right" },
  { id: "paneUp", label: "Focus pane up" },
  { id: "paneDown", label: "Focus pane down" },
  { id: "zoomPane", label: "Zoom pane" },
  { id: "closePane", label: "Close pane" },
  { id: "copyMode", label: "Copy mode", comingSoon: true },
  { id: "switchHost", label: "Switch host" },
  { id: "commandPalette", label: "Command palette" },
  { id: "cheatSheet", label: "Shortcut cheat sheet" },
];

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta"]);

// The one key the app steals from the terminal.
export function isPrefixTriggerEvent(event: PrefixKeyEventLike): boolean {
  return (
    event.ctrlKey &&
    !event.altKey &&
    !event.metaKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === "b"
  );
}

// Bindings are matched on KeyboardEvent.key: case-sensitive for symbols,
// lowercase for letters.
function matchKey(key: string): string {
  return key.length === 1 && /[a-z]/i.test(key) ? key.toLowerCase() : key;
}

function buildKeyMap(bindings: PrefixBindings): Map<string, PrefixActionId> {
  const map = new Map<string, PrefixActionId>();
  for (const definition of PREFIX_ACTION_DEFINITIONS) {
    const key = bindings[definition.id];
    const normalized = key ? matchKey(key) : "";
    if (normalized && !map.has(normalized)) map.set(normalized, definition.id);
  }
  return map;
}

export interface PrefixEngine {
  handleKeydown(event: PrefixKeyEventLike): PrefixResult;
  isArmed(): boolean;
  reset(): void;
  setBindings(bindings: PrefixBindings): void;
}

export function createPrefixEngine(
  bindings: PrefixBindings = { ...DEFAULT_PREFIX_BINDINGS },
): PrefixEngine {
  let armed = false;
  let keyToAction = buildKeyMap(bindings);

  return {
    handleKeydown(event) {
      if (!armed) {
        if (isPrefixTriggerEvent(event)) {
          armed = true;
          return { type: "arm" };
        }
        return { type: "pass" };
      }

      // Plain modifier keydowns keep the armed state so shifted symbols
      // ("%" = Shift+5) can follow. The key itself passes through.
      if (MODIFIER_KEYS.has(event.key)) return { type: "pass" };

      armed = false;
      if (event.key === "Escape") return { type: "disarm" };
      if (isPrefixTriggerEvent(event)) return { type: "literal" };

      // Bound keys match on `key` alone; ctrl/alt/meta are ignored because
      // single-key bindings never require them.
      const action = keyToAction.get(matchKey(event.key));
      if (action) return { type: "action", action };
      return { type: "swallow" };
    },
    isArmed() {
      return armed;
    },
    reset() {
      armed = false;
    },
    setBindings(next: PrefixBindings) {
      keyToAction = buildKeyMap(next);
    },
  };
}

// ---- bindings persistence (localStorage, same pattern as the old
// workspaceShortcuts module but for single keys) ----

export function normalizePrefixKey(key: string): string | null {
  if (!key || MODIFIER_KEYS.has(key)) return null;
  // Esc is reserved for disarming the prefix state.
  if (key === "Escape") return null;
  return matchKey(key);
}

export function loadPrefixBindings(
  storage: Pick<Storage, "getItem"> | null = getBrowserStorage(),
): PrefixBindings {
  if (!storage) return { ...DEFAULT_PREFIX_BINDINGS };
  let saved: Partial<Record<PrefixActionId, unknown>> = {};
  try {
    const raw = storage.getItem(PREFIX_BINDINGS_STORAGE_KEY);
    saved = raw ? JSON.parse(raw) : {};
  } catch {
    saved = {};
  }

  const bindings = { ...DEFAULT_PREFIX_BINDINGS };
  for (const definition of PREFIX_ACTION_DEFINITIONS) {
    const value = saved[definition.id];
    if (typeof value === "string" && normalizePrefixKey(value) === value) {
      bindings[definition.id] = value;
    }
  }
  return bindings;
}

// Cached view of the browser-storage bindings for hot paths (the global
// keydown handler reloads bindings on every key press). The cache is
// invalidated by the save/reset helpers below (same tab) and by the
// `storage` event (other tabs); callers that pass an explicit storage
// bypass it entirely.
let cachedBindings: PrefixBindings | null = null;
let storageListenerInstalled = false;

export function invalidatePrefixBindingsCache() {
  cachedBindings = null;
}

function installStorageInvalidation() {
  if (storageListenerInstalled || typeof window === "undefined") return;
  storageListenerInstalled = true;
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key === PREFIX_BINDINGS_STORAGE_KEY) {
      cachedBindings = null;
    }
  });
}

export function loadPrefixBindingsCached(): PrefixBindings {
  if (!cachedBindings) {
    installStorageInvalidation();
    cachedBindings = loadPrefixBindings();
  }
  return cachedBindings;
}

export function savePrefixBindings(
  bindings: PrefixBindings,
  storage: Pick<Storage, "setItem"> | null = getBrowserStorage(),
) {
  invalidatePrefixBindingsCache();
  if (!storage) return;
  storage.setItem(PREFIX_BINDINGS_STORAGE_KEY, JSON.stringify(bindings));
}

export function savePrefixBinding(
  action: PrefixActionId,
  key: string,
  storage: Pick<Storage, "getItem" | "setItem"> | null = getBrowserStorage(),
): PrefixBindings {
  const normalized = normalizePrefixKey(key) ?? DEFAULT_PREFIX_BINDINGS[action];
  const next = { ...loadPrefixBindings(storage), [action]: normalized };
  savePrefixBindings(next, storage);
  return next;
}

export function getPrefixBindingConflict(
  action: PrefixActionId,
  key: string,
  bindings: PrefixBindings = loadPrefixBindings(),
): PrefixActionId | null {
  const normalized = normalizePrefixKey(key);
  if (!normalized) return null;
  for (const definition of PREFIX_ACTION_DEFINITIONS) {
    if (definition.id === action) continue;
    if (matchKey(bindings[definition.id]) === normalized) {
      return definition.id;
    }
  }
  return null;
}

export function resetPrefixBindings(
  storage: Pick<Storage, "removeItem"> | null = getBrowserStorage(),
): PrefixBindings {
  invalidatePrefixBindingsCache();
  if (storage) storage.removeItem(PREFIX_BINDINGS_STORAGE_KEY);
  return { ...DEFAULT_PREFIX_BINDINGS };
}

// "⌃B c" style label for Settings and the cheat sheet.
export function formatPrefixBinding(
  action: PrefixActionId,
  bindings: PrefixBindings = loadPrefixBindings(),
): string {
  return `⌃B ${displayPrefixKey(bindings[action])}`;
}

function displayPrefixKey(key: string): string {
  switch (key) {
    case "ArrowLeft":
      return "←";
    case "ArrowRight":
      return "→";
    case "ArrowUp":
      return "↑";
    case "ArrowDown":
      return "↓";
    case " ":
      return "Space";
    default:
      return key;
  }
}

export function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined") return false;
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toLowerCase();
  return (
    tagName === "input" ||
    tagName === "textarea" ||
    tagName === "select" ||
    target.isContentEditable
  );
}

function getBrowserStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
