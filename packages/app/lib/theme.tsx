import React, {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import { Platform, useColorScheme } from "react-native";
import { paletteAlpha, paletteColors } from "./themePalette";
import {
  DEFAULT_DARK_THEME,
  DEFAULT_SYSTEM_THEMES,
  THEMES,
  parseSystemThemes,
  parseTheme,
  resolveThemeId,
  terminalMinimumContrast,
  themeCssVariables,
  type SystemThemes,
  type Theme,
  type ThemeDefinition,
  type ThemeId,
  type ThemeScheme,
} from "./themes";

export type { SystemThemes, Theme } from "./themes";
type ResolvedTheme = ThemeScheme;

const STORAGE_KEY = "offdesk:theme";
const SYSTEM_KEY = "offdesk:theme-system";
// What app.config.js's head script paints before this bundle loads.
const CSS_CACHE_KEY = "offdesk:theme-css";
const DARK_MEDIA = "(prefers-color-scheme: dark)";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    // Storage can be unavailable in private browsing or server rendering.
    return null;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Keep the in-memory choice when storage is unavailable.
  }
}

const readTheme = () => parseTheme(read(STORAGE_KEY));
const readSystemThemes = () => parseSystemThemes(read(SYSTEM_KEY));

function readSystemTheme(): ResolvedTheme {
  return typeof window !== "undefined" && window.matchMedia(DARK_MEDIA).matches
    ? "dark"
    : "light";
}

function applyTheme(theme: ThemeDefinition) {
  if (Platform.OS !== "web" || typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.toggle("dark", theme.scheme === "dark");
  root.dataset.theme = theme.id;
  root.style.colorScheme = theme.scheme;
  for (const [name, value] of Object.entries(themeCssVariables(theme))) root.style.setProperty(name, value);
}

// The head script repaints from this on the next launch, before the bundle.
function cacheThemeCss(theme: Theme, pair: SystemThemes) {
  const entry = (id: ThemeId) => ({ id, scheme: THEMES[id].scheme, vars: themeCssVariables(THEMES[id]) });
  write(CSS_CACHE_KEY, JSON.stringify(theme === "system"
    ? { system: { light: entry(pair.light), dark: entry(pair.dark) } }
    : { fixed: entry(theme) }));
}

// Apply the saved choice as the app loads, before React mounts its screens.
if (Platform.OS === "web" && typeof window !== "undefined") {
  applyTheme(THEMES[resolveThemeId(readTheme(), readSystemTheme(), readSystemThemes())]);
}

interface ThemeContextValue {
  theme: Theme;
  // The theme in use (the system's pick when theme is "system").
  themeId: ThemeId;
  definition: ThemeDefinition;
  // Whether the theme in use is light or dark.
  resolvedTheme: ResolvedTheme;
  systemThemes: SystemThemes;
  setTheme: (theme: Theme) => void;
  setSystemThemes: (pair: SystemThemes) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: "system",
  themeId: DEFAULT_DARK_THEME,
  definition: THEMES[DEFAULT_DARK_THEME],
  resolvedTheme: "dark",
  systemThemes: DEFAULT_SYSTEM_THEMES,
  setTheme: () => {},
  setSystemThemes: () => {},
});
const useBrowserLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, updateTheme] = useState<Theme>(readTheme);
  const [systemThemes, updateSystemThemes] = useState<SystemThemes>(readSystemThemes);
  const nativeSystemTheme = useColorScheme();
  const [webSystemTheme, setWebSystemTheme] = useState(readSystemTheme);
  const systemTheme = Platform.OS === "web" ? webSystemTheme : nativeSystemTheme;
  const themeId = resolveThemeId(theme, systemTheme === "dark" ? "dark" : "light", systemThemes);
  const definition = THEMES[themeId];

  useBrowserLayoutEffect(() => applyTheme(definition), [definition]);
  useEffect(() => cacheThemeCss(theme, systemThemes), [theme, systemThemes]);

  useEffect(() => {
    if (Platform.OS !== "web") return;
    // NativeWind's class-based color scheme can override Appearance on web.
    // Read the OS media query directly so our own dark class cannot pin it.
    const media = window.matchMedia(DARK_MEDIA);
    const sync = () => setWebSystemTheme(media.matches ? "dark" : "light");
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (Platform.OS !== "web") return;
    const sync = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY || event.key === null) updateTheme(readTheme());
      if (event.key === SYSTEM_KEY || event.key === null) updateSystemThemes(readSystemThemes());
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  const value = useMemo<ThemeContextValue>(() => ({
    theme,
    themeId,
    definition,
    resolvedTheme: definition.scheme,
    systemThemes,
    setTheme: (next: Theme) => {
      updateTheme(next);
      write(STORAGE_KEY, next);
    },
    setSystemThemes: (pair: SystemThemes) => {
      updateSystemThemes(pair);
      write(SYSTEM_KEY, JSON.stringify(pair));
    },
  }), [theme, themeId, definition, systemThemes]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}

export function useColors() {
  const { definition } = useTheme();
  return useMemo(() => paletteColors(definition), [definition]);
}

export function useColorAlpha() {
  const { definition } = useTheme();
  return useMemo(() => paletteAlpha(definition), [definition]);
}

// The terminal's colours for the theme in use, and how hard xterm should
// lift pale text on a light terminal.
export function useTerminalTheme() {
  const { definition } = useTheme();
  return useMemo(() => ({
    theme: definition.terminal,
    minimumContrastRatio: terminalMinimumContrast(definition),
  }), [definition]);
}
