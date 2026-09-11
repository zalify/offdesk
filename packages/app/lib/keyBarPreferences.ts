import { useEffect, useState } from "react";

export const KEYBAR_STORAGE_KEY = "offdesk:keybar-layout:v1";
const changed = "offdesk:keybar-layout-changed";
export const KEYBAR_KEYS = {
  "ctrl-c": "Ctrl+C", esc: "Esc", tab: "Tab", "shift-tab": "Shift+Tab", slash: "/",
  backspace: "Backspace", shift: "Shift", paste: "Paste", attach: "Attach file",
  "select-toggle": "Select text", "ctrl-latch": "Ctrl", space: "Space",
  at: "@", tilde: "~", pipe: "|", dash: "-", underscore: "_",
  home: "Home", end: "End", "ctrl-d": "Ctrl+D", "ctrl-z": "Ctrl+Z", "ctrl-l": "Ctrl+L",
} as const;
export type KeyBarKey = keyof typeof KEYBAR_KEYS;
export type KeyBarLayout = { primary: KeyBarKey[]; secondary: KeyBarKey[] };
export const DEFAULT_KEYBAR_LAYOUT: KeyBarLayout = {
  primary: ["ctrl-c", "esc", "tab", "shift-tab", "slash"],
  secondary: ["backspace", "shift", "paste", "attach", "select-toggle", "ctrl-latch", "space", "at", "tilde", "pipe", "dash", "underscore"],
};

export function sanitizeKeyBarLayout(value: unknown): KeyBarLayout {
  if (!value || typeof value !== "object" || !("primary" in value) || !("secondary" in value)
    || !Array.isArray(value.primary) || !Array.isArray(value.secondary)) return DEFAULT_KEYBAR_LAYOUT;
  const seen = new Set<string>();
  const valid = (items: unknown[], limit: number) => items.filter((id): id is KeyBarKey => {
    if (typeof id !== "string" || !Object.hasOwn(KEYBAR_KEYS, id) || seen.has(id) || limit <= 0) return false;
    seen.add(id); limit--; return true;
  });
  return { primary: valid(value.primary, 5), secondary: valid(value.secondary, Object.keys(KEYBAR_KEYS).length) };
}
export function loadKeyBarLayout(): KeyBarLayout {
  try { return sanitizeKeyBarLayout(JSON.parse(localStorage.getItem(KEYBAR_STORAGE_KEY) ?? "null")); }
  catch { return DEFAULT_KEYBAR_LAYOUT; }
}
export function saveKeyBarLayout(layout: KeyBarLayout): boolean {
  try {
    localStorage.setItem(KEYBAR_STORAGE_KEY, JSON.stringify(sanitizeKeyBarLayout(layout)));
    window.dispatchEvent(new Event(changed)); return true;
  } catch { return false; }
}
export function useKeyBarLayout() {
  const [layout, setLayout] = useState(loadKeyBarLayout);
  useEffect(() => {
    const update = () => setLayout(loadKeyBarLayout());
    const storage = (event: StorageEvent) => { if (event.key === null || event.key === KEYBAR_STORAGE_KEY) update(); };
    window.addEventListener(changed, update); window.addEventListener("storage", storage);
    return () => { window.removeEventListener(changed, update); window.removeEventListener("storage", storage); };
  }, []);
  return layout;
}
