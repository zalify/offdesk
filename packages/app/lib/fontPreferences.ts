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
  const size = Number(localStorage.getItem("offdesk:ui-font-size"));
  style.fontSize = size >= 10 && size <= 20 ? `${size}px` : "";
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
