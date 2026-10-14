// Concrete colors for React Native styles, from the theme registry
// (lib/themes.ts). On the web the same values arrive as CSS variables.
import { THEMES, DEFAULT_DARK_THEME, DEFAULT_LIGHT_THEME, type ThemeDefinition } from "./themes";

export function paletteColors(theme: ThemeDefinition) {
  const u = theme.ui;
  return {
    bg0: u.bg0, bg1: u.bg1, bg2: u.bg2, bg3: u.bg3,
    line: u.line, lineSoft: u.lineSoft,
    fg0: u.fg0, fg1: u.fg1, fg2: u.fg2, fg3: u.fg3,
    ok: u.accent, warn: u.warn, err: u.warn, info: u.accent, violet: u.fg2,
    termBg: theme.terminal.background, termFg: theme.terminal.foreground, termAccent: theme.terminal.cursor,
    onAccent: u.onAccent, primary: u.primary, onPrimary: u.onPrimary, onErr: u.onErr, focus: u.accent,

    // Legacy keys.
    background: u.bg0, backgroundSecondary: u.bg1, surface: u.bg2, surfaceHover: u.bg3,
    foreground: u.fg0, foregroundSecondary: u.fg1, foregroundMuted: u.fg2,
    accent: u.accent, accentDim: u.accent,
    danger: u.warn, warning: u.warn, success: u.accent,
    border: u.line, borderActive: u.accent,
  };
}

const rgba = (hex: string, alpha: number) => {
  const v = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

export function paletteAlpha(theme: ThemeDefinition) {
  const u = theme.ui;
  const dark = theme.scheme === "dark";
  return {
    accentSoft: rgba(u.accent, 0.1),
    accentLine: rgba(u.accent, dark ? 0.35 : 0.4),
    dangerSoft: rgba(u.warn, dark ? 0.14 : 0.12),
    dangerLine: rgba(u.warn, 0.5),
    overlay: rgba(dark ? u.bg0 : "#0c0c0b", dark ? 0.72 : 0.4),

    accentSubtle: rgba(u.accent, 0.06),
    accentLight: rgba(u.accent, 0.08),
    accentLight12: rgba(u.accent, 0.1),
    accentMedium15: rgba(u.accent, 0.12),
    accentMedium: rgba(u.accent, 0.16),
    accentBorder: rgba(u.accent, dark ? 0.25 : 0.3),
    backgroundDim: rgba(u.bg0, 0.15),
    backgroundOverlay: rgba(u.bg0, 0.2),
    backgroundShadow: dark ? "rgba(0, 0, 0, 0.3)" : rgba("#0c0c0b", 0.2),
    backgroundOpaque96: rgba(u.bg0, 0.96),
    backgroundOpaque98: rgba(u.bg0, 0.98),
    backgroundSecondaryOpaque96: rgba(u.bg1, 0.96),
    surfaceOpaque94: rgba(u.bg2, 0.94),
    foregroundOverlay: rgba(u.fg0, 0.12),
    foregroundSubtle: rgba(u.fg0, 0.35),
    warningSubtle: rgba(u.warn, 0.06),
    warningLight12: rgba(u.warn, 0.1),
    warningBorder: rgba(u.warn, 0.3),
    warningBorder22: rgba(u.warn, 0.3),
    mutedLight: rgba(u.fg2, 0.12),
    mutedMedium: rgba(u.fg2, 0.25),
  };
}

export const lightColors = paletteColors(THEMES[DEFAULT_LIGHT_THEME]);
export const lightAlpha = paletteAlpha(THEMES[DEFAULT_LIGHT_THEME]);
export const darkColors = paletteColors(THEMES[DEFAULT_DARK_THEME]);
export const darkAlpha = paletteAlpha(THEMES[DEFAULT_DARK_THEME]);
