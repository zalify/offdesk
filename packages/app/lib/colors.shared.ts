// The default terminal colours (Graphite's), for code with no theme context.
// Live terminals follow the chosen theme through useTerminalTheme() in
// lib/theme.tsx; each theme's colours are in lib/themes.ts.
import { DEFAULT_DARK_THEME, THEMES } from "./themes";

export const terminalTheme = THEMES[DEFAULT_DARK_THEME].terminal;
