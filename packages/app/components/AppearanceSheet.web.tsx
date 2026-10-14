// The phone's appearance sheet ([m] › appearance): themes and the terminal
// font, tried on the live terminal above it. Every tap applies at once;
// cancel puts back what was there when the sheet opened.
import { useEffect, useState } from "react";
import { colors } from "@/lib/colors";
import { useTheme } from "@/lib/theme";
import { THEMES } from "@/lib/themes";
import { readTerminalFontSetting, writeTerminalFontSetting } from "@/lib/fontPreferences";
import { DEFAULT_TERMINAL_FONT, quoteFontFamily } from "@/lib/terminalFonts";
import { ThemeRow } from "./ThemePicker";

// Fonts a phone has: the two the app ships, and Menlo on iPhone. Settings
// lists every font for computers that have more installed.
const PHONE_FONTS = [
  { value: "", label: DEFAULT_TERMINAL_FONT },
  { value: "Geist Mono", label: "Geist Mono" },
  { value: "Menlo", label: "Menlo" },
];
const DEFAULT_SIZE = 14;

export function AppearanceSheet({ onClose }: { onClose: () => void }) {
  const { theme, themeId, setTheme } = useTheme();
  const [opened] = useState(() => ({ theme, font: readTerminalFontSetting() }));
  const [tab, setTab] = useState<"theme" | "font">("theme");
  const [font, setFont] = useState(opened.font);
  const size = font.size ?? DEFAULT_SIZE;

  const applyFont = (next: { family: string; size: number | null }) => {
    setFont(next);
    writeTerminalFontSetting(next);
  };
  const cancel = () => {
    setTheme(opened.theme);
    writeTerminalFontSetting(opened.font);
    onClose();
  };
  const changed = theme !== opened.theme || font.family !== opened.font.family || font.size !== opened.font.size;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") cancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const tabButton = (value: "theme" | "font") => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === value}
      data-testid={`appearance-tab-${value}`}
      onClick={() => setTab(value)}
      style={{
        minHeight: 32, padding: "0 14px", border: 0, borderRadius: 3, cursor: "pointer",
        fontFamily: "var(--font-display)", fontSize: 12.5,
        background: tab === value ? colors.bg3 : "transparent",
        color: tab === value ? colors.fg0 : colors.fg2,
        fontWeight: tab === value ? 600 : 500,
      }}
    >
      {value}
    </button>
  );
  const row: React.CSSProperties = {
    display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, minHeight: 48,
    borderTop: `1px solid ${colors.lineSoft}`, fontFamily: "var(--font-display)", fontSize: 13, color: colors.fg1,
  };
  const stepButton: React.CSSProperties = {
    width: 44, height: 40, borderRadius: 3, border: `1px solid ${colors.line}`, background: "transparent",
    color: colors.fg0, fontFamily: "var(--font-display)", fontSize: 13, cursor: "pointer",
  };

  return (
    <div data-testid="appearance-sheet" style={{ position: "absolute", inset: 0, zIndex: 30, display: "flex", flexDirection: "column" }}>
      {/* No dimming: the terminal above is the preview. Tapping it keeps the choice. */}
      <button type="button" aria-label="Close appearance" onClick={onClose} style={{ flex: 1, border: 0, padding: 0, background: "transparent", cursor: "default" }} />
      <div
        role="dialog"
        aria-label="Appearance"
        style={{
          display: "flex", flexDirection: "column", gap: 12,
          padding: "8px 16px max(14px, env(safe-area-inset-bottom))",
          background: colors.bg2, borderTop: `1px solid ${colors.line}`,
          borderTopLeftRadius: 16, borderTopRightRadius: 16,
          boxShadow: "0 -16px 40px rgb(0 0 0 / 0.3)",
          animation: "offdeskSlideUp 200ms cubic-bezier(0.16, 1, 0.3, 1)",
        }}
      >
        <span style={{ alignSelf: "center", width: 40, height: 4, borderRadius: 2, background: colors.line }} />
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontFamily: "var(--font-display)", fontSize: 17, fontWeight: 600, letterSpacing: "-0.02em", color: colors.fg0 }}>appearance</span>
          <span style={{ flex: 1 }} />
          <div role="tablist" aria-label="Appearance" style={{ display: "flex", gap: 2, padding: 2, border: `1px solid ${colors.line}`, borderRadius: 4 }}>
            {tabButton("theme")}
            {tabButton("font")}
          </div>
        </div>

        {tab === "theme" ? (
          <>
            <span style={{ fontFamily: "var(--font-sans)", fontSize: 13, color: colors.fg2 }}>
              Tap to try it on this terminal. Swipe for more.
            </span>
            <ThemeRow />
          </>
        ) : (
          <>
            <span style={{ fontFamily: "var(--font-sans)", fontSize: 13, color: colors.fg2 }}>terminal font</span>
            <div role="group" aria-label="Terminal font" style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {PHONE_FONTS.map((option) => {
                const on = (font.family || "") === option.value || (!option.value && font.family === DEFAULT_TERMINAL_FONT);
                return (
                  <button
                    key={option.label}
                    type="button"
                    aria-pressed={on}
                    onClick={() => applyFont({ ...font, family: option.value })}
                    style={{
                      minHeight: 40, padding: "0 14px", borderRadius: 3, cursor: "pointer",
                      fontFamily: `${quoteFontFamily(option.label)}, monospace`, fontSize: 13,
                      border: `1px solid ${on ? colors.primary : colors.line}`,
                      background: on ? colors.primary : "transparent",
                      color: on ? colors.onPrimary : colors.fg1,
                      fontWeight: on ? 600 : 400,
                    }}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
            <div style={row}>
              <span>terminal size</span>
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <button type="button" aria-label="Smaller terminal text" style={stepButton} disabled={size <= 10} onClick={() => applyFont({ ...font, size: Math.max(10, size - 1) })}>A−</button>
                <span data-testid="appearance-font-size" style={{ width: 52, textAlign: "center", color: colors.fg0, fontWeight: 600 }}>{size}px</span>
                <button type="button" aria-label="Larger terminal text" style={stepButton} disabled={size >= 24} onClick={() => applyFont({ ...font, size: Math.min(24, size + 1) })}>A+</button>
              </span>
            </div>
            <span style={{ fontFamily: "var(--font-sans)", fontSize: 12.5, color: colors.fg3 }}>More fonts are in Settings.</span>
          </>
        )}

        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            data-testid="appearance-cancel"
            onClick={cancel}
            style={{ flex: 1, minHeight: 46, borderRadius: 4, border: `1px solid ${colors.line}`, background: "transparent", color: colors.fg0, fontFamily: "var(--font-display)", fontSize: 13.5, cursor: "pointer" }}
          >
            cancel
          </button>
          <button
            type="button"
            data-testid="appearance-done"
            onClick={onClose}
            style={{ flex: 1, minHeight: 46, borderRadius: 4, border: 0, background: colors.primary, color: colors.onPrimary, fontFamily: "var(--font-display)", fontSize: 13.5, fontWeight: 600, cursor: "pointer" }}
          >
            {changed && theme !== opened.theme ? `use ${THEMES[themeId].name.toLowerCase()}` : "done"}
          </button>
        </div>
      </div>
    </div>
  );
}
