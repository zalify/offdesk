// Every theme the app offers: the interface tokens (global.css names them;
// lib/theme.tsx writes them onto <html>) and the terminal's colours (xterm).
// Graphite is the default dark theme and Paper the default light one;
// global.css carries their values too, for the first paint.
import type { ITheme } from "@xterm/xterm";

export type ThemeScheme = "light" | "dark";

export interface ThemeTokens {
  bg0: string; bg1: string; bg2: string; bg3: string;
  // line = control edges (buttons, inputs); lineSoft = hairlines.
  line: string; lineSoft: string;
  fg0: string; fg1: string; fg2: string; fg3: string;
  // accent = the active colour's ink (text, icons, edges); primary = the fill
  // behind onPrimary text ("in control", ^C, primary buttons).
  accent: string; onAccent: string;
  primary: string; onPrimary: string;
  // Waiting, danger and errors share one colour, always with a word.
  warn: string; onErr: string;
}

export interface TerminalColors extends ITheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string; red: string; green: string; yellow: string;
  blue: string; magenta: string; cyan: string; white: string;
  brightBlack: string; brightRed: string; brightGreen: string; brightYellow: string;
  brightBlue: string; brightMagenta: string; brightCyan: string; brightWhite: string;
}

export interface ThemeDefinition {
  id: ThemeId;
  name: string;
  // A few words for the picker.
  tag: string;
  scheme: ThemeScheme;
  ui: ThemeTokens;
  terminal: TerminalColors;
}

const graphiteTerminal: TerminalColors = {
  background: "#191917",
  foreground: "#d6d4cd",
  cursor: "#b9d35f",
  cursorAccent: "#191917",
  selectionBackground: "rgba(185, 211, 95, 0.25)",
  black: "#2a2a27", red: "#e3907d", green: "#9ccf6a", yellow: "#e0c068",
  blue: "#7fa8d9", magenta: "#c79ad8", cyan: "#74c2b4", white: "#c3c1ba",
  brightBlack: "#77756f", brightRed: "#eda593", brightGreen: "#b9d35f", brightYellow: "#ecd28a",
  brightBlue: "#9dbde3", brightMagenta: "#d7b3e4", brightCyan: "#94d3c7", brightWhite: "#ecebe6",
};

export const THEME_IDS = ["graphite", "midnight", "slate", "ember", "paper", "sepia", "sage"] as const;
export type ThemeId = (typeof THEME_IDS)[number];

export const THEMES: Record<ThemeId, ThemeDefinition> = {
  // Softer than Midnight: a lifted black and a quieter lime, for long sessions.
  graphite: {
    id: "graphite", name: "Graphite", tag: "default", scheme: "dark",
    ui: {
      bg0: "#191917", bg1: "#1d1d1b", bg2: "#21211f", bg3: "#2a2a27",
      line: "#474641", lineSoft: "#31302d",
      fg0: "#dcdad3", fg1: "#c3c1ba", fg2: "#a29f98", fg3: "#87857e",
      accent: "#b9d35f", onAccent: "#191917", primary: "#a9c64b", onPrimary: "#191917",
      warn: "#e3907d", onErr: "#191917",
    },
    terminal: graphiteTerminal,
  },
  // Direction B as it first shipped: true black and full lime.
  midnight: {
    id: "midnight", name: "Midnight", tag: "contrast", scheme: "dark",
    ui: {
      bg0: "#0c0c0b", bg1: "#111110", bg2: "#141413", bg3: "#1c1c1a",
      line: "#3a3936", lineSoft: "#2a2927",
      fg0: "#ecebe6", fg1: "#cfcdc7", fg2: "#aeaca6", fg3: "#8f8d87",
      accent: "#d4ff3a", onAccent: "#0c0c0b", primary: "#d4ff3a", onPrimary: "#0c0c0b",
      warn: "#ff8a75", onErr: "#0c0c0b",
    },
    terminal: {
      background: "#0c0c0b", foreground: "#ecebe6", cursor: "#d4ff3a", cursorAccent: "#0c0c0b",
      selectionBackground: "rgba(212, 255, 58, 0.28)",
      black: "#1c1c1a", red: "#ff8a75", green: "#a6e36a", yellow: "#f2cc60",
      blue: "#7cb7ff", magenta: "#d39bf5", cyan: "#6fd6c6", white: "#cfcdc7",
      brightBlack: "#8f8d87", brightRed: "#ffa392", brightGreen: "#d4ff3a", brightYellow: "#ffe08a",
      brightBlue: "#a3cdff", brightMagenta: "#e4b8ff", brightCyan: "#93e6d8", brightWhite: "#ffffff",
    },
  },
  // Blue-grey and low contrast, in the spirit of Nord.
  slate: {
    id: "slate", name: "Slate", tag: "cool", scheme: "dark",
    ui: {
      bg0: "#2b303a", bg1: "#2f3540", bg2: "#343a46", bg3: "#3b4250",
      line: "#566072", lineSoft: "#3f4654",
      fg0: "#d8dee9", fg1: "#c4cbd7", fg2: "#a7b0bf", fg3: "#8f99aa",
      accent: "#a3be8c", onAccent: "#2b303a", primary: "#a3be8c", onPrimary: "#2b303a",
      warn: "#d08770", onErr: "#2b303a",
    },
    terminal: {
      background: "#2b303a", foreground: "#d8dee9", cursor: "#a3be8c", cursorAccent: "#2b303a",
      selectionBackground: "rgba(136, 192, 208, 0.25)",
      black: "#3b4252", red: "#bf616a", green: "#a3be8c", yellow: "#ebcb8b",
      blue: "#81a1c1", magenta: "#b48ead", cyan: "#88c0d0", white: "#e5e9f0",
      brightBlack: "#6c7689", brightRed: "#d4777f", brightGreen: "#b4cf9c", brightYellow: "#f0d7a1",
      brightBlue: "#93b3d3", brightMagenta: "#c6a0c0", brightCyan: "#8fbcbb", brightWhite: "#eceff4",
    },
  },
  // Warm and low in blue light, for late nights.
  ember: {
    id: "ember", name: "Ember", tag: "night", scheme: "dark",
    ui: {
      bg0: "#1c1814", bg1: "#201b17", bg2: "#241f1a", bg3: "#2d2620",
      line: "#4d4237", lineSoft: "#342c25",
      fg0: "#e6d9c3", fg1: "#cfc2ad", fg2: "#ab9f8b", fg3: "#928671",
      accent: "#e0a65a", onAccent: "#1c1814", primary: "#d99e50", onPrimary: "#1c1814",
      warn: "#e57f6b", onErr: "#1c1814",
    },
    terminal: {
      background: "#1c1814", foreground: "#e0d3bd", cursor: "#e0a65a", cursorAccent: "#1c1814",
      selectionBackground: "rgba(224, 166, 90, 0.25)",
      black: "#2d2620", red: "#e57f6b", green: "#a9c27a", yellow: "#e0b768",
      blue: "#8fa9c4", magenta: "#c99bb0", cyan: "#8fbfae", white: "#cfc2ad",
      brightBlack: "#807563", brightRed: "#ee9a86", brightGreen: "#bfd496", brightYellow: "#ecca8a",
      brightBlue: "#a9bfd4", brightMagenta: "#dab3c4", brightCyan: "#a8d0c2", brightWhite: "#f0e6d4",
    },
  },
  // Ink on white. The terminal stays dark (Graphite's).
  paper: {
    id: "paper", name: "Paper", tag: "light", scheme: "light",
    ui: {
      bg0: "#f5f5f3", bg1: "#fbfbfa", bg2: "#ffffff", bg3: "#ebebe7",
      line: "#c4c2bb", lineSoft: "#e2e1dc",
      fg0: "#111111", fg1: "#2b2a27", fg2: "#4f4d48", fg3: "#65635d",
      accent: "#4a6000", onAccent: "#ffffff", primary: "#c6e26a", onPrimary: "#111111",
      warn: "#b4381f", onErr: "#ffffff",
    },
    terminal: graphiteTerminal,
  },
  // Warm paper and brown ink, terminal included.
  sepia: {
    id: "sepia", name: "Sepia", tag: "eye care", scheme: "light",
    ui: {
      bg0: "#f1e7d0", bg1: "#f5ecd8", bg2: "#f9f2e2", bg3: "#e8dcc1",
      line: "#bfae8c", lineSoft: "#ddd0b3",
      fg0: "#3a2f22", fg1: "#4a3d2d", fg2: "#5f513c", fg3: "#75654d",
      accent: "#7a5a14", onAccent: "#f9f2e2", primary: "#e3c36f", onPrimary: "#3a2f22",
      warn: "#a8432a", onErr: "#f9f2e2",
    },
    terminal: {
      background: "#f4ead3", foreground: "#3a2f22", cursor: "#7a5a14", cursorAccent: "#f4ead3",
      selectionBackground: "rgba(122, 90, 20, 0.2)",
      black: "#3a2f22", red: "#a8432a", green: "#4f6b1e", yellow: "#8a6100",
      blue: "#2f5f8a", magenta: "#84466f", cyan: "#2c6e66", white: "#7d6e57",
      brightBlack: "#8a7b63", brightRed: "#b84a30", brightGreen: "#5f7d28", brightYellow: "#8f6600",
      brightBlue: "#3d6f9c", brightMagenta: "#94537f", brightCyan: "#337a71", brightWhite: "#5a4c38",
    },
  },
  // The classic pale green eye-care page.
  sage: {
    id: "sage", name: "Sage", tag: "eye care", scheme: "light",
    ui: {
      bg0: "#c7e6cb", bg1: "#cdeacf", bg2: "#d6eed7", bg3: "#b9dabd",
      line: "#8fb395", lineSoft: "#b2d3b6",
      fg0: "#1f3326", fg1: "#2b4232", fg2: "#3a5441", fg3: "#4a6550",
      accent: "#22613a", onAccent: "#eaf6eb", primary: "#2f6f45", onPrimary: "#eaf6eb",
      warn: "#9c3b2a", onErr: "#eaf6eb",
    },
    terminal: {
      background: "#d0ead3", foreground: "#1f3326", cursor: "#22613a", cursorAccent: "#d0ead3",
      selectionBackground: "rgba(34, 97, 58, 0.2)",
      black: "#1f3326", red: "#9c3b2a", green: "#2c6b2f", yellow: "#6f5500",
      blue: "#24557f", magenta: "#7a3f6b", cyan: "#1f6863", white: "#4f6b56",
      brightBlack: "#4f6b56", brightRed: "#a8412e", brightGreen: "#2f7032", brightYellow: "#735800",
      brightBlue: "#2a5d8a", brightMagenta: "#844575", brightCyan: "#22706a", brightWhite: "#2b4232",
    },
  },
};

export const DEFAULT_DARK_THEME: ThemeId = "graphite";
export const DEFAULT_LIGHT_THEME: ThemeId = "paper";

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && (THEME_IDS as readonly string[]).includes(value);
}

// "#c6e26a" -> "198 226 106", the triplet form global.css uses so
// `rgb(var(--x) / <alpha>)` works in Tailwind and inline styles.
export function hexToTriplet(hex: string): string {
  const value = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16)).join(" ");
}

// The CSS custom properties a theme sets. The legacy aliases in global.css
// point at these, so they follow.
export function themeCssVariables(theme: ThemeDefinition): Record<string, string> {
  const ui = theme.ui;
  const triplets: Record<string, string> = {
    "--color-bg-0": ui.bg0, "--color-bg-1": ui.bg1, "--color-bg-2": ui.bg2, "--color-bg-3": ui.bg3,
    "--color-line": ui.line, "--color-line-soft": ui.lineSoft,
    "--color-fg-0": ui.fg0, "--color-fg-1": ui.fg1, "--color-fg-2": ui.fg2, "--color-fg-3": ui.fg3,
    "--color-accent": ui.accent, "--color-on-accent": ui.onAccent,
    "--color-primary": ui.primary, "--color-on-primary": ui.onPrimary,
    "--color-focus": ui.accent, "--color-ok": ui.accent, "--color-info": ui.accent,
    "--color-warn": ui.warn, "--color-err": ui.warn, "--color-on-err": ui.onErr,
    "--color-violet": ui.fg2,
    "--color-term-bg": theme.terminal.background, "--color-term-fg": theme.terminal.foreground,
    "--color-term-accent": theme.terminal.cursor,
  };
  return Object.fromEntries(Object.entries(triplets).map(([name, hex]) => [name, hexToTriplet(hex)]));
}

// Light terminals: programs that assume a dark background print pale
// colours. xterm lifts any text below this contrast against its cell.
export function terminalMinimumContrast(theme: ThemeDefinition): number {
  return relativeLuminance(theme.terminal.background) > 0.5 ? 3 : 1;
}

// WCAG 2 relative luminance and contrast ratio, for the picker's checks and tests.
export function relativeLuminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.replace("#", "").slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// The saved choice: a theme, or "system", where the device's light or dark
// setting picks one of a pair (Paper and Graphite unless changed).
export type Theme = ThemeId | "system";
export type SystemThemes = { light: ThemeId; dark: ThemeId };
export const DEFAULT_SYSTEM_THEMES: SystemThemes = { light: DEFAULT_LIGHT_THEME, dark: DEFAULT_DARK_THEME };

// Before there were themes the choice was "light" or "dark".
export function parseTheme(value: unknown): Theme {
  if (value === "light") return DEFAULT_LIGHT_THEME;
  if (value === "dark") return DEFAULT_DARK_THEME;
  return value === "system" || isThemeId(value) ? value : "system";
}

export function parseSystemThemes(value: string | null): SystemThemes {
  try {
    const parsed = value ? JSON.parse(value) : null;
    return {
      light: isThemeId(parsed?.light) ? parsed.light : DEFAULT_SYSTEM_THEMES.light,
      dark: isThemeId(parsed?.dark) ? parsed.dark : DEFAULT_SYSTEM_THEMES.dark,
    };
  } catch {
    return DEFAULT_SYSTEM_THEMES;
  }
}

export function resolveThemeId(theme: Theme, system: ThemeScheme, pair: SystemThemes): ThemeId {
  return theme === "system" ? pair[system] : theme;
}
