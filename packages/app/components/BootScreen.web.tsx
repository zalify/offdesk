import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { colors } from "@/lib/colors";
import { fontDisplay } from "./Primitives.web";
import { BOOT_STEPS, pickBootTips, type BootStep } from "@/lib/bootScreen";

const WORDMARK = "offdesk/dev";
// The wordmark types itself out once per page load, then holds.
const TYPE_START_MS = 120;
const TYPE_MS = 440;
// A tip only for a wait long enough to read one; a second one for a long wait.
const FIRST_TIP_MS = 2000;
const SECOND_TIP_MS = 8000;
const TIP_FADE_MS = 240;

/**
 * One loading screen from launch to the first terminal: sign-in, the Hub's
 * first answer and the terminal's first paint each mount their own copy, so
 * every animation is timed from page start rather than from mount, and the
 * tips are drawn once per page load. Handing over between copies is
 * invisible: the typing, the dots and the tip carry on where they were.
 */
export function BootScreen({
  step,
  detail,
  leaving = false,
  onLeft,
  overlay = false,
}: {
  step: BootStep;
  detail?: string;
  /** Fade out (an overlay lifting off the terminal it waited for). */
  leaving?: boolean;
  onLeft?: () => void;
  /** Cover the terminal area (its parent) rather than fill the screen. */
  overlay?: boolean;
}) {
  // Over the terminal area the content keeps the place it had full screen,
  // so the wordmark stays put while the title bar appears above it.
  const rootRef = useRef<HTMLDivElement>(null);
  const [shift, setShift] = useState(0);
  useLayoutEffect(() => {
    if (!overlay || !rootRef.current) return;
    const rect = rootRef.current.getBoundingClientRect();
    setShift(document.documentElement.clientHeight / 2 - (rect.top + rect.height / 2));
  }, [overlay]);
  // Read once per mount: CSS delays below are offset by it, so a remount
  // continues each animation instead of restarting it.
  const [elapsed] = useState(() => Math.round(performance.now()));
  const [tips] = useState(pickBootTips);
  const after = (ms: number) => `${ms - elapsed}ms`;
  const current = BOOT_STEPS.indexOf(step);

  return (
    <div
      ref={rootRef}
      data-testid="boot-screen"
      data-step={step}
      role="status"
      aria-live="polite"
      onAnimationEnd={(event) => {
        if (leaving && event.target === event.currentTarget) onLeft?.();
      }}
      style={{
        ...(overlay
          ? { position: "absolute", inset: 0, zIndex: 20 }
          : { flex: 1, width: "100%", minHeight: 0 }),
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
        background: colors.bg0,
        fontFamily: fontDisplay,
        animation: leaving ? "offdeskFadeOut 200ms ease-out both" : undefined,
      }}
    >
      <div
        style={{
          width: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 22,
          padding: "0 24px",
          boxSizing: "border-box",
          transform: shift ? `translateY(${shift}px)` : undefined,
        }}
      >
      <div
        aria-label="Offdesk Dev"
        role="img"
        style={{ fontSize: 24, fontWeight: 600, color: colors.fg0, display: "flex", alignItems: "baseline" }}
      >
        <span
          aria-hidden="true"
          className="odk-boot-anim"
          style={{
            display: "inline-block",
            overflow: "hidden",
            whiteSpace: "nowrap",
            width: `${WORDMARK.length}ch`,
            animation: `offdeskBootType ${TYPE_MS}ms steps(${WORDMARK.length}, end) ${after(TYPE_START_MS)} both`,
          }}
        >
          offdesk<span style={{ color: colors.accent }}>/dev</span>
        </span>
        <span className="odk-cursor" aria-hidden="true" />
      </div>

      <div aria-hidden="true" style={{ display: "flex", gap: 10, alignItems: "center", height: 6 }}>
        {BOOT_STEPS.map((name, index) => (
          <span
            key={name}
            className={index === current ? "odk-boot-anim" : undefined}
            style={dotStyle(index < current ? "done" : index === current ? "active" : "todo")}
          />
        ))}
      </div>

      <div style={{ fontSize: 11, color: colors.fg3, minHeight: 16, textAlign: "center" }}>
        {detail ?? STEP_LABEL[step]}
      </div>

      <div
        data-testid="boot-tips"
        className="odk-boot-anim"
        style={{
          position: "relative",
          width: "100%",
          maxWidth: 320,
          minHeight: 92,
          marginTop: 12,
          boxSizing: "border-box",
          border: `1px solid ${colors.line}`,
          borderRadius: 12,
          background: colors.bg1,
          padding: 16,
          animation: `offdeskSlideUp 320ms ease-out ${after(FIRST_TIP_MS)} both`,
        }}
      >
        <div style={{ fontSize: 10, letterSpacing: "0.08em", color: colors.fg3, marginBottom: 8 }}>TIP</div>
        <div style={{ position: "relative" }}>
          <p
            className="odk-boot-anim"
            style={{
              ...TIP_TEXT,
              animation: `offdeskFadeOut ${TIP_FADE_MS}ms ease-in ${after(SECOND_TIP_MS)} forwards`,
            }}
          >
            {tips[0]}
          </p>
          <p
            className="odk-boot-anim"
            style={{
              ...TIP_TEXT,
              position: "absolute",
              inset: 0,
              animation: `offdeskFadeIn ${TIP_FADE_MS}ms ease-out ${after(SECOND_TIP_MS + TIP_FADE_MS)} both`,
            }}
          >
            {tips[1]}
          </p>
        </div>
      </div>
      </div>
    </div>
  );
}

const STEP_LABEL: Record<BootStep, string> = {
  signin: "signing in",
  hub: "connecting to your Hub",
  terminal: "opening your terminal",
};

const TIP_TEXT: CSSProperties = {
  margin: 0,
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  lineHeight: 1.5,
  color: colors.fg1,
};

function dotStyle(state: "done" | "active" | "todo"): CSSProperties {
  return {
    width: state === "active" ? 18 : 6,
    height: 6,
    borderRadius: 3,
    background: state === "todo" ? colors.line : colors.accent,
    animation: state === "active" ? "offdeskBootPulse 1.2s ease-in-out infinite" : undefined,
  };
}
