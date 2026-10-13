// Direction B primitives: monospace chrome, sans-serif prose, one lime
// accent, radii 3–6px. Plain DOM, like the rest of the desktop chrome; the
// look lives in Primitives.css so hover, focus and touch sizes work without
// inline-style tricks. DESIGN.md is the reference.

import type { CSSProperties, ReactNode } from "react";

import { colors } from "@/lib/colors";
import "./Primitives.css";

/** Geist Mono: chrome, headings, labels. */
export const fontDisplay = "var(--font-display)";
/** Geist: paragraphs, descriptions, help text. */
export const fontProse = "var(--font-sans)";

type ButtonKind = "primary" | "secondary" | "ghost" | "danger" | "bracket";

export function Button({
  kind = "primary",
  size = "md",
  children,
  onClick,
  disabled,
  style,
  testId,
  type = "button",
  ariaLabel,
}: {
  kind?: ButtonKind;
  size?: "md" | "sm";
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  style?: CSSProperties;
  testId?: string;
  type?: "button" | "submit";
  ariaLabel?: string;
}) {
  const variant = kind === "bracket" ? "secondary odk-btn--bracket" : kind;
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      aria-label={ariaLabel}
      className={`odk-btn odk-btn--${variant}${size === "sm" ? " odk-btn--sm" : ""}`}
      style={style}
    >
      {kind === "bracket" ? <Bracketed>{children}</Bracketed> : children}
    </button>
  );
}

/** `[enter]`: the brackets are decoration, so they stay out of the name. */
export function Bracketed({ children }: { children: ReactNode }) {
  return (
    <>
      <span className="odk-bracket" aria-hidden="true">[</span>
      {children}
      <span className="odk-bracket" aria-hidden="true">]</span>
    </>
  );
}

type ChipKind = "outline" | "solid" | "waiting";

export function Chip({
  kind = "outline",
  glyph,
  children,
  title,
  style,
  testId,
}: {
  kind?: ChipKind;
  /** A leading mark in the accent colour, like the agent marker's ⌁. */
  glyph?: string;
  children: ReactNode;
  title?: string;
  style?: CSSProperties;
  testId?: string;
}) {
  return (
    <span className={`odk-chip${kind === "outline" ? "" : ` odk-chip--${kind}`}`} title={title} style={style} data-testid={testId}>
      {glyph ? <span className="odk-chip-glyph" aria-hidden="true">{glyph}</span> : null}
      {children}
    </span>
  );
}

/** "opened by agent · cli": a terminal an API token opened (see #518). */
export function AgentMarker({ label, style, testId }: { label?: string | null; style?: CSSProperties; testId?: string }) {
  const via = label?.trim();
  return (
    <Chip glyph="⌁" title={via ? `Opened by an agent through ${via}` : "Opened by an agent"} style={style} testId={testId}>
      {via ? `opened by agent · ${via}` : "opened by agent"}
    </Chip>
  );
}

export function Field({
  label,
  htmlFor,
  help,
  error,
  children,
  style,
}: {
  label: ReactNode;
  htmlFor?: string;
  help?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div className="odk-field" style={style}>
      <label className="odk-label" htmlFor={htmlFor}>{label}</label>
      {children}
      {error ? <span className="odk-help odk-help--error" role="alert">{error}</span> : help ? <span className="odk-help">{help}</span> : null}
    </div>
  );
}

/** For inputs that cannot take the class (React Native Web TextInput). */
export const inputStyle: CSSProperties = {
  width: "100%",
  height: 38,
  padding: "0 12px",
  borderRadius: 4,
  border: `1px solid ${colors.line}`,
  background: colors.bg1,
  color: colors.fg0,
  fontFamily: fontDisplay,
  fontSize: 13,
  outline: "none",
  boxSizing: "border-box",
};

export function Card({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div className="odk-panel" style={style}>{children}</div>;
}

export function WaitingCard({
  title,
  children,
  style,
  testId,
}: {
  title: ReactNode;
  children?: ReactNode;
  style?: CSSProperties;
  testId?: string;
}) {
  return (
    <div className="odk-waiting" role="status" style={style} data-testid={testId}>
      <div className="odk-waiting-title">{title}</div>
      {children ? <div className="odk-waiting-actions">{children}</div> : null}
    </div>
  );
}

/** A small mono label above a heading: "~ $ first run", "hub". */
export function Eyebrow({
  children,
  color = colors.fg3,
  prompt = false,
}: {
  children: ReactNode;
  color?: string;
  /** Prefix with the shell prompt the setup screens use. */
  prompt?: boolean;
}) {
  return (
    <div style={{ fontFamily: fontDisplay, fontSize: 13, fontWeight: 500, color }}>
      {prompt ? (
        <>
          <span style={{ color: colors.accent }} aria-hidden="true">~</span>
          <span aria-hidden="true"> $ </span>
        </>
      ) : null}
      {children}
    </div>
  );
}

export function Display({
  children,
  size = 36,
  cursor = false,
  style,
}: {
  children: ReactNode;
  size?: number;
  /** End with the lime block cursor, as the first screens do. */
  cursor?: boolean;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        fontFamily: fontDisplay,
        fontSize: size,
        fontWeight: 600,
        letterSpacing: size >= 28 ? "-0.035em" : "-0.02em",
        lineHeight: 1.15,
        color: colors.fg0,
        textWrap: "balance",
        ...style,
      } as CSSProperties}
    >
      {children}
      {cursor ? <span className="odk-cursor" aria-hidden="true" /> : null}
    </div>
  );
}

export function Body({ children, size = 15, style }: { children: ReactNode; size?: number; style?: CSSProperties }) {
  return (
    <div style={{ fontFamily: fontProse, fontSize: size, lineHeight: 1.55, color: colors.fg2, ...style }}>{children}</div>
  );
}

/** A setup step's state, the way a checklist prints it: [✓] [~] [ ]. */
export function StepMark({ state, label }: { state: "done" | "active" | "todo"; label?: string }) {
  const text = state === "done" ? "[✓]" : state === "active" ? "[~]" : "[ ]";
  const name = label ?? (state === "done" ? "Done" : state === "active" ? "In progress" : "Not started");
  return (
    <span className={`odk-step-mark${state === "done" ? "" : ` odk-step-mark--${state}`}`} role="img" aria-label={name}>
      {text}
    </span>
  );
}

/** A step badge for the big "hub" / "client" choices. Pass a check or a number. */
export function Donut({
  children,
  color = colors.accent,
  size = 36,
}: {
  children: ReactNode;
  color?: string;
  size?: number;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        borderRadius: 6,
        border: `1px solid ${color}`,
        background: "transparent",
        fontFamily: fontDisplay,
        fontSize: Math.round(size * 0.4),
        fontWeight: 600,
        color,
        flexShrink: 0,
      }}
    >
      {children}
    </span>
  );
}

/** The desk with a terminal window flying off it (logo v1). */
export function Logo({ size = 28, title }: { size?: number; title?: string }) {
  const height = Math.round((size * 32) / 40);
  return (
    <svg
      width={size}
      height={height}
      viewBox="0 0 40 32"
      fill="none"
      stroke="currentColor"
      strokeWidth={size < 24 ? 3 : 2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      style={{ flexShrink: 0, color: colors.fg0 }}
    >
      <path d="M3 23h18M5.5 23v7M18.5 23v7" />
      {size >= 24 ? <path d="M19.5 16l3-2M18 12.5l3-2" /> : null}
      <g transform="rotate(-14 30 9)">
        <rect x="23" y="3" width="15" height="12" rx="2.5" />
        <path d={size >= 24 ? "M26.5 7.2l2 1.6-2 1.6M30.5 11h3" : "M26.5 7.2l2 1.6-2 1.6"} stroke={colors.accent} />
      </g>
    </svg>
  );
}

/** The `offdesk/dev` lockup. */
export function Wordmark({ size = 18 }: { size?: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }} role="img" aria-label="Offdesk DEV">
      <Logo size={Math.round(size * 2)} />
      <span aria-hidden="true" style={{ fontFamily: fontDisplay, fontSize: size, fontWeight: 600, letterSpacing: "-0.02em", color: colors.fg0 }}>
        offdesk<span style={{ color: colors.accent }}>/dev</span>
      </span>
    </div>
  );
}

export function Check({ size = 16, color = colors.fg0 }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12l5 5 9-10" />
    </svg>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        minHeight: "100vh",
        background: colors.bg0,
        color: colors.fg2,
        fontFamily: fontDisplay,
        fontSize: 13,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 20,
          height: 20,
          borderRadius: "50%",
          border: `2px solid ${colors.line}`,
          borderTopColor: colors.accent,
          animation: "offdeskSpin 0.9s linear infinite",
        }}
      />
      {label ? <span>{label}</span> : null}
    </div>
  );
}

/* ── Workspace chrome ─────────────────────────────────────────────── */

/** A tmux-style tab: "0:app claude". */
export function Tab({
  index,
  name,
  meta,
  alert,
  active,
  onClick,
  testId,
}: {
  index: number;
  name: string;
  meta?: ReactNode;
  alert?: boolean;
  active?: boolean;
  onClick?: () => void;
  testId?: string;
}) {
  return (
    <button type="button" role="tab" aria-selected={!!active} className="odk-tab" onClick={onClick} data-testid={testId}>
      <span>{index}:{name}</span>
      {meta ? <span className="odk-tab-meta">{meta}</span> : null}
      {alert ? <span className="odk-tab-alert" aria-label="waiting">!</span> : null}
    </button>
  );
}

/** The workspace's bottom line: what needs you on the left, where you are on the right. */
export function StatusLine({ children, style, testId }: { children: ReactNode; style?: CSSProperties; testId?: string }) {
  return (
    <div className="odk-status" role="status" style={style} data-testid={testId}>
      {children}
    </div>
  );
}

export function StatusBadge({ children }: { children: ReactNode }) {
  return <span className="odk-status-badge">{children}</span>;
}

export function StatusEnd({ active, children, testId }: { active?: boolean; children: ReactNode; testId?: string }) {
  return (
    <span className={`odk-status-end${active ? " odk-status-end--active" : ""}`} data-testid={testId}>
      {children}
    </span>
  );
}
