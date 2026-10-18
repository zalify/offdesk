import { quoteFontFamily, resolveTerminalFontFamily } from "./terminalFonts";

export const FONT_PREFERENCES_CHANGED = "offdesk:font-preferences-changed";

export function resolveUiFontFamily(value: string | null): string | null {
  const font = value?.trim();
  if (!font) return null;
  if (font === "System UI") return "system-ui, -apple-system, sans-serif";
  return `${quoteFontFamily(font)}, system-ui, sans-serif`;
}

export function readTerminalFontPreferences() {
  const size = Number(localStorage.getItem("offdesk:terminal-font-size"));
  return {
    fontFamily: resolveTerminalFontFamily(localStorage.getItem("offdesk:terminal-font-family")),
    fontSize: Number.isFinite(size) && size > 0 ? Math.max(10, Math.min(24, size)) : 14,
  };
}

export function applyUiFontPreferences() {
  const style = document.documentElement.style;
  const family = resolveUiFontFamily(localStorage.getItem("offdesk:ui-font-family"));
  for (const property of ["--font-sans", "--font-display"]) {
    if (family) style.setProperty(property, family);
    else style.removeProperty(property);
  }
  style.fontSize = uiRootFontSize(Number(localStorage.getItem("offdesk:ui-font-size")));
}

// The Interface text size is the size of body text, 14px by default. UI text
// is in rem (see rem.ts), so scaling the root by size / 14 scales all of it
// and keeps the browser's own default size as the base.
export const DEFAULT_UI_FONT_SIZE = 14;

export function uiRootFontSize(size: number): string {
  if (!(size >= 10 && size <= 20) || size === DEFAULT_UI_FONT_SIZE) return "";
  return `${+((size / DEFAULT_UI_FONT_SIZE) * 100).toFixed(4)}%`;
}

export function notifyFontPreferencesChanged() {
  window.dispatchEvent(new Event(FONT_PREFERENCES_CHANGED));
}

export function subscribeFontPreferences(listener: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || /^offdesk:(ui|terminal)-font-/.test(event.key)) listener();
  };
  window.addEventListener(FONT_PREFERENCES_CHANGED, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(FONT_PREFERENCES_CHANGED, listener);
    window.removeEventListener("storage", onStorage);
  };
}

// The terminal font as saved: a family name ("" = the default) and a size
// in px (null = the default). Writes notify open terminals, which re-render
// in place.
export function readTerminalFontSetting(): { family: string; size: number | null } {
  const size = Number(localStorage.getItem("offdesk:terminal-font-size"));
  return {
    family: localStorage.getItem("offdesk:terminal-font-family") ?? "",
    size: Number.isFinite(size) && size >= 10 && size <= 24 ? size : null,
  };
}

export function writeTerminalFontSetting({ family, size }: { family: string; size: number | null }) {
  if (family) localStorage.setItem("offdesk:terminal-font-family", family);
  else localStorage.removeItem("offdesk:terminal-font-family");
  if (size !== null) localStorage.setItem("offdesk:terminal-font-size", String(size));
  else localStorage.removeItem("offdesk:terminal-font-size");
  notifyFontPreferencesChanged();
}
