// The site's vocabulary, indoors: pill buttons with a hard coral shadow,
// cream cards with a big radius, the coral "donut" step badge, Fredoka for
// what is said once. Plain DOM with inline styles, like the rest of the
// desktop chrome. Values are the site's (site/src/styles/global.css).

import type { CSSProperties, ReactNode } from "react";

import { colors } from "@/lib/colors";

export const fontDisplay =
  "'Fredoka Variable', 'Fredoka', ui-rounded, 'Nunito Variable', system-ui, sans-serif";

type ButtonKind = "coral" | "sky" | "ghost";

const buttonBase: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  height: 44,
  padding: "0 22px",
  borderRadius: 999,
  fontFamily: fontDisplay,
  fontSize: 15,
  fontWeight: 600,
  cursor: "pointer",
  whiteSpace: "nowrap",
  transition: "transform 120ms ease, box-shadow 120ms ease, opacity 120ms ease",
};

const buttonKinds: Record<ButtonKind, CSSProperties> = {
  coral: {
    background: colors.accent,
    color: colors.onAccent,
    border: "none",
    boxShadow: `0 5px 0 0 ${colors.err}`,
  },
  sky: {
    background: colors.bg1,
    color: colors.fg0,
    border: `2px solid ${colors.line}`,
  },
  ghost: {
    background: "transparent",
    color: colors.fg2,
    border: "none",
  },
};

export function Button({
  kind = "coral",
  children,
  onClick,
  disabled,
  style,
  testId,
  type = "button",
}: {
  kind?: ButtonKind;
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  style?: CSSProperties;
  testId?: string;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      style={{
        ...buttonBase,
        ...buttonKinds[kind],
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? "default" : "pointer",
        ...style,
      }}
    >
      {children}
    </button>
  );
}

export function Card({
  children,
  style,
  sticker = false,
}: {
  children: ReactNode;
  style?: CSSProperties;
  /** The sun-coloured offset shadow the site puts under its one hero card. */
  sticker?: boolean;
}) {
  return (
    <div
      style={{
        background: colors.bg1,
        border: `1px solid ${colors.lineSoft}`,
        borderRadius: 28,
        padding: 28,
        boxShadow: sticker ? "12px 12px 0 0 #ffc857" : "0 10px 30px -18px rgb(43 35 64 / 0.35)",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function Eyebrow({ children, color = colors.accent }: { children: ReactNode; color?: string }) {
  return (
    <div
      style={{
        fontFamily: fontDisplay,
        fontSize: 13,
        fontWeight: 600,
        letterSpacing: "0.06em",
        color,
      }}
    >
      {children}
    </div>
  );
}

export function Display({ children, size = 36, style }: { children: ReactNode; size?: number; style?: CSSProperties }) {
  return (
    <div
      style={{
        fontFamily: fontDisplay,
        fontSize: size,
        fontWeight: 700,
        letterSpacing: "-0.01em",
        lineHeight: 1.08,
        color: colors.fg0,
        textWrap: "balance",
        ...style,
      } as CSSProperties}
    >
      {children}
    </div>
  );
}

export function Body({ children, size = 15, style }: { children: ReactNode; size?: number; style?: CSSProperties }) {
  return (
    <div style={{ fontSize: size, lineHeight: 1.55, color: colors.fg2, ...style }}>{children}</div>
  );
}

/** The site's step badge: a thick coral ring. Pass a check or a number. */
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
        borderRadius: "50%",
        border: `5px solid ${color}`,
        background: colors.bg1,
        fontFamily: fontDisplay,
        fontSize: 15,
        fontWeight: 700,
        color: colors.fg0,
        flexShrink: 0,
      }}
    >
      {children}
    </span>
  );
}

export const inputStyle: CSSProperties = {
  width: "100%",
  height: 46,
  padding: "0 14px",
  borderRadius: 14,
  border: `2px solid ${colors.line}`,
  background: colors.bg1,
  color: colors.fg0,
  fontFamily: "var(--font-mono)",
  fontSize: 13,
  outline: "none",
  boxSizing: "border-box",
};

/** The donut from the site's wordmark, at any size. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" style={{ flexShrink: 0 }}>
      <circle cx="50" cy="50" r="27" fill="none" stroke="#ff6b57" strokeWidth="22" />
      <path d="M26 22l9-6" stroke="#38b6e3" strokeWidth="7" strokeLinecap="round" />
      <path d="M68 25l7 7" stroke="#ff8fb1" strokeWidth="7" strokeLinecap="round" />
      <path d="M15 56l-3 9" stroke="#ffc857" strokeWidth="7" strokeLinecap="round" />
      <path d="M60 80l10 2" stroke="#5ed3c1" strokeWidth="7" strokeLinecap="round" />
      <path d="M40 84l-8 4" stroke="#ff8fb1" strokeWidth="7" strokeLinecap="round" />
    </svg>
  );
}

export function Wordmark({ size = 20 }: { size?: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <Logo size={size + 8} />
      <span style={{ fontFamily: fontDisplay, fontSize: size, fontWeight: 700, color: colors.fg0 }}>offdesk</span>
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
        fontSize: 14,
        fontWeight: 600,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 28,
          height: 28,
          borderRadius: "50%",
          border: `4px solid ${colors.line}`,
          borderTopColor: colors.accent,
          animation: "offdesk-spin 0.9s linear infinite",
        }}
      />
      <style>{"@keyframes offdesk-spin { to { transform: rotate(360deg); } }"}</style>
      {label ? <span>{label}</span> : null}
    </div>
  );
}
