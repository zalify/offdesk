import React, {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
} from "react";
import { Platform, useColorScheme } from "react-native";
import { lightColors, darkColors, lightAlpha, darkAlpha } from "./themePalette";

export type Theme = "light" | "dark" | "system";
type ResolvedTheme = "light" | "dark";
const STORAGE_KEY = "offdesk:theme";
const DARK_MEDIA = "(prefers-color-scheme: dark)";
function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark" || value === "system";
}

function readTheme(): Theme {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (isTheme(value)) return value;
  } catch {
    // Storage can be unavailable in private browsing or server rendering.
  }
  // Preserve the existing appearance until the user chooses another one.
  return "light";
}

function applyTheme(theme: ResolvedTheme) {
  if (Platform.OS !== "web" || typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
}

function readSystemTheme(): ResolvedTheme {
  return typeof window !== "undefined" && window.matchMedia(DARK_MEDIA).matches
    ? "dark"
    : "light";
}

// Apply the saved choice as the app loads, before React mounts its screens.
if (Platform.OS === "web" && typeof window !== "undefined") {
  const theme = readTheme();
  applyTheme(
    theme === "system"
      ? readSystemTheme()
      : theme,
  );
}

interface ThemeContextValue {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: "light",
  resolvedTheme: "light",
  setTheme: () => {},
});
const useBrowserLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, updateTheme] = useState<Theme>(readTheme);
  const nativeSystemTheme = useColorScheme();
  const [webSystemTheme, setWebSystemTheme] = useState(readSystemTheme);
  const systemTheme = Platform.OS === "web" ? webSystemTheme : nativeSystemTheme;
  const resolvedTheme: ResolvedTheme = theme === "system"
    ? (systemTheme === "dark" ? "dark" : "light")
    : theme;

  useBrowserLayoutEffect(() => applyTheme(resolvedTheme), [resolvedTheme]);

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
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  const setTheme = (value: Theme) => {
    updateTheme(value);
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch {
      // Keep the in-memory choice when storage is unavailable.
    }
  };

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}

export function useColors() {
  return useTheme().resolvedTheme === "dark" ? darkColors : lightColors;
}

export function useColorAlpha() {
  return useTheme().resolvedTheme === "dark" ? darkAlpha : lightAlpha;
}
