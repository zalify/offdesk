// Theme choice: cards that preview each theme in its own colours (Settings),
// a swipeable row of small ones (the phone's appearance sheet), and the
// "follow the system" pair. The themes are in lib/themes.ts.
import { colors } from "@/lib/colors";
import { useTheme, type SystemThemes } from "@/lib/theme";
import { THEME_IDS, THEMES, type ThemeDefinition, type ThemeId } from "@/lib/themes";
import { rem } from "@/lib/rem";

const GROUPS: { label: string; ids: ThemeId[] }[] = [
  { label: "dark", ids: THEME_IDS.filter((id) => THEMES[id].scheme === "dark") },
  { label: "light & eye care", ids: THEME_IDS.filter((id) => THEMES[id].scheme === "light") },
];

// A theme in miniature: its tab bar, terminal lines and key row, in its own colours.
function ThemeMiniature({ theme, height }: { theme: ThemeDefinition; height: number }) {
  const { ui, terminal } = theme;
  const bar = (width: string, color: string) => (
    <span style={{ display: "block", height: 4, width, borderRadius: 2, background: color }} />
  );
  return (
    <span
      aria-hidden="true"
      style={{
        display: "flex", flexDirection: "column", width: "100%", height, overflow: "hidden",
        borderRadius: 4, border: `1px solid ${ui.line}`, background: ui.bg0, boxSizing: "border-box",
      }}
    >
      <span style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 12, padding: "0 6px", background: ui.bg1, borderBottom: `1px solid ${ui.lineSoft}` }}>
        <span style={{ width: 22, height: 2, background: ui.accent }} />
        <span style={{ width: 14, height: 2 }} />
      </span>
      <span style={{ flex: 1, display: "flex", flexDirection: "column", gap: 5, padding: "7px 7px", background: terminal.background }}>
        {bar("78%", terminal.foreground)}
        {bar("52%", terminal.red)}
        {bar("36%", terminal.cursor)}
      </span>
      <span style={{ display: "flex", gap: 3, padding: 4, background: ui.bg1, borderTop: `1px solid ${ui.lineSoft}` }}>
        <span style={{ flex: 1, height: 8, borderRadius: 2, background: ui.primary }} />
        {[0, 1, 2].map((i) => <span key={i} style={{ flex: 1, height: 8, borderRadius: 2, border: `1px solid ${ui.line}`, boxSizing: "border-box" }} />)}
      </span>
    </span>
  );
}

function ThemeCard({ id, pressed, onPick, compact }: { id: ThemeId; pressed: boolean; onPick: () => void; compact?: boolean }) {
  const theme = THEMES[id];
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={`${theme.name} theme`}
      data-testid={`theme-${id}`}
      onClick={onPick}
      style={{
        display: "flex", flexDirection: "column", gap: 6, padding: 6, minWidth: 0,
        width: compact ? 84 : undefined, flexShrink: 0,
        borderRadius: 6, cursor: "pointer", textAlign: "left", font: "inherit",
        background: pressed ? colors.bg3 : "transparent",
        border: `1px solid ${pressed ? colors.accent : colors.lineSoft}`,
        boxShadow: pressed ? `0 0 0 1px ${colors.accent}` : "none",
      }}
    >
      <ThemeMiniature theme={theme} height={compact ? 96 : 72} />
      <span style={{ display: "flex", justifyContent: compact ? "center" : "space-between", alignItems: "baseline", gap: 6, width: "100%" }}>
        <span style={{ fontFamily: "var(--font-display)", fontSize: rem(12.5), fontWeight: pressed ? 600 : 500, color: pressed ? colors.fg0 : colors.fg1, textTransform: "lowercase" }}>
          {theme.name}
        </span>
        {!compact && <span style={{ fontFamily: "var(--font-display)", fontSize: rem(11), color: colors.fg3 }}>{theme.tag}</span>}
      </span>
    </button>
  );
}

// Settings: every theme, grouped, as cards in a grid.
// As many columns as fit, so a foldable or tablet gets four, a phone two.
// auto-fill keeps empty tracks, so cards line up across the groups.
export function ThemeGrid() {
  const { theme, setTheme } = useTheme();
  return (
    <div role="group" aria-label="Theme" style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 10 }}>
      {GROUPS.map((group) => (
        <div key={group.label} role="group" aria-label={`${group.label} themes`} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span style={{ fontFamily: "var(--font-display)", fontSize: rem(12), color: colors.fg3 }}>{group.label}</span>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 10 }}>
            {group.ids.map((id) => <ThemeCard key={id} id={id} pressed={theme === id} onPick={() => setTheme(id)} />)}
          </div>
        </div>
      ))}
    </div>
  );
}

// The phone's appearance sheet: one row to swipe through, applied as it is tapped.
export function ThemeRow() {
  const { themeId, setTheme } = useTheme();
  return (
    <div role="group" aria-label="Themes" data-testid="theme-row" style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 4, scrollbarWidth: "none" }}>
      {THEME_IDS.map((id) => <ThemeCard key={id} id={id} compact pressed={themeId === id} onPick={() => setTheme(id)} />)}
    </div>
  );
}

function PairSelect({ label, scheme, value, onChange }: { label: string; scheme: "light" | "dark"; value: ThemeId; onChange: (id: ThemeId) => void }) {
  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontFamily: "var(--font-display)", fontSize: rem(12.5), color: colors.fg3 }}>
      {label}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as ThemeId)}
        style={{
          minHeight: 32, padding: "0 8px", borderRadius: 3, border: `1px solid ${colors.line}`,
          background: colors.bg2, color: colors.fg0, fontFamily: "var(--font-display)", fontSize: rem(12.5), textTransform: "lowercase",
        }}
      >
        {THEME_IDS.filter((id) => THEMES[id].scheme === scheme).map((id) => <option key={id} value={id}>{THEMES[id].name}</option>)}
      </select>
    </label>
  );
}

// Follow the system: switch between two themes with the device's light or dark setting.
export function FollowSystem() {
  const { theme, themeId, systemThemes, setTheme, setSystemThemes } = useTheme();
  const on = theme === "system";
  const setPair = (patch: Partial<SystemThemes>) => setSystemThemes({ ...systemThemes, ...patch });
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px 16px" }}>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label="Follow the system"
        data-testid="theme-follow-system"
        onClick={() => setTheme(on ? themeId : "system")}
        style={{
          flexShrink: 0, width: 44, height: 26, borderRadius: 13, padding: 3, cursor: "pointer",
          display: "flex", justifyContent: on ? "flex-end" : "flex-start",
          border: `1px solid ${on ? colors.primary : colors.line}`, background: on ? colors.primary : colors.bg2,
        }}
      >
        <span style={{ width: 18, height: 18, borderRadius: 9, background: on ? colors.onPrimary : colors.fg3 }} />
      </button>
      {on && <PairSelect label="when light" scheme="light" value={systemThemes.light} onChange={(light) => setPair({ light })} />}
      {on && <PairSelect label="when dark" scheme="dark" value={systemThemes.dark} onChange={(dark) => setPair({ dark })} />}
    </div>
  );
}
