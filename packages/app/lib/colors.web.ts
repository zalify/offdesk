// CSS-variable-based color constants for inline styles.
// Direction B — see global.css for source tokens and DESIGN.md for the rules.
export const colors = {
  // New design tokens — preferred for new components.
  bg0: 'rgb(var(--color-bg-0))',
  bg1: 'rgb(var(--color-bg-1))',
  bg2: 'rgb(var(--color-bg-2))',
  bg3: 'rgb(var(--color-bg-3))',
  line: 'rgb(var(--color-line))',
  lineSoft: 'rgb(var(--color-line-soft))',
  fg0: 'rgb(var(--color-fg-0))',
  fg1: 'rgb(var(--color-fg-1))',
  fg2: 'rgb(var(--color-fg-2))',
  fg3: 'rgb(var(--color-fg-3))',
  ok: 'rgb(var(--color-ok))',
  warn: 'rgb(var(--color-warn))',
  err: 'rgb(var(--color-err))',
  info: 'rgb(var(--color-info))',
  violet: 'rgb(var(--color-violet))',
  termBg: 'rgb(var(--color-term-bg))',
  termFg: 'rgb(var(--color-term-fg))',
  // The terminal's own accent (its cursor colour), for prompts drawn on termBg.
  termAccent: 'rgb(var(--color-term-accent))',
  onAccent: 'rgb(var(--color-on-accent))',
  // The lime fill (primary buttons, "in control") and what sits on it.
  primary: 'rgb(var(--color-primary))',
  onPrimary: 'rgb(var(--color-on-primary))',
  // Text on a waiting/danger fill.
  onErr: 'rgb(var(--color-on-err))',
  focus: 'rgb(var(--color-focus))',

  // Legacy keys — kept so untouched components keep working.
  background: 'rgb(var(--color-background))',
  backgroundSecondary: 'rgb(var(--color-background-secondary))',
  surface: 'rgb(var(--color-surface))',
  surfaceHover: 'rgb(var(--color-surface-hover))',
  foreground: 'rgb(var(--color-foreground))',
  foregroundSecondary: 'rgb(var(--color-foreground-secondary))',
  foregroundMuted: 'rgb(var(--color-foreground-muted))',
  accent: 'rgb(var(--color-accent))',
  accentDim: 'rgb(var(--color-accent-dim))',
  danger: 'rgb(var(--color-danger))',
  warning: 'rgb(var(--color-warning))',
  success: 'rgb(var(--color-success))',
  border: 'rgb(var(--color-border))',
  borderActive: 'rgb(var(--color-border-active))',
} as const;

// Pre-computed alpha variants.
export const colorAlpha = {
  // New design tokens.
  accentSoft: 'rgb(var(--color-accent) / 0.14)',   // chip fill
  accentLine: 'rgb(var(--color-accent) / 0.35)',   // chip/border stroke
  dangerSoft: 'rgb(var(--color-err) / 0.25)',
  dangerLine: 'rgb(var(--color-err) / 0.5)',
  overlay: 'rgb(12 12 11 / 0.72)',

  // Legacy.
  accentSubtle: 'rgb(var(--color-accent) / 0.08)',
  accentLight: 'rgb(var(--color-accent) / 0.1)',
  accentLight12: 'rgb(var(--color-accent) / 0.12)',
  accentMedium15: 'rgb(var(--color-accent) / 0.15)',
  accentMedium: 'rgb(var(--color-accent) / 0.2)',
  accentBorder: 'rgb(var(--color-accent) / 0.25)',
  backgroundDim: 'rgb(var(--color-background) / 0.15)',
  backgroundOverlay: 'rgb(var(--color-background) / 0.2)',
  backgroundShadow: 'rgb(0 0 0 / 0.3)',
  backgroundOpaque96: 'rgb(var(--color-background) / 0.96)',
  backgroundOpaque98: 'rgb(var(--color-background) / 0.98)',
  backgroundSecondaryOpaque96: 'rgb(var(--color-background-secondary) / 0.96)',
  surfaceOpaque94: 'rgb(var(--color-surface) / 0.94)',
  foregroundOverlay: 'rgb(var(--color-foreground) / 0.15)',
  foregroundSubtle: 'rgb(var(--color-foreground) / 0.35)',
  warningSubtle: 'rgb(var(--color-warning) / 0.08)',
  warningLight12: 'rgb(var(--color-warning) / 0.12)',
  warningBorder: 'rgb(var(--color-warning) / 0.2)',
  warningBorder22: 'rgb(var(--color-warning) / 0.22)',
  mutedLight: 'rgb(var(--color-foreground-muted) / 0.15)',
  mutedMedium: 'rgb(var(--color-foreground-muted) / 0.3)',
} as const;

export { terminalTheme } from './colors.shared';
