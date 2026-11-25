// Small shared pieces for the draft-databases UI: button styles, a fixed
// popover that escapes scroll containers, and the external-link opener.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { createPortal } from "react-dom";

import { colors, colorAlpha } from "@/lib/colors";
import { rem } from "@/lib/rem";
import { isTauri } from "@/lib/platform";
import { createExternalUrlOpener, isSafeExternalUrl } from "@/lib/terminalLinks";

export const MONO = "var(--font-display)";

export function smallBtn(opts: { compact?: boolean; active?: boolean; danger?: boolean } = {}): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    minHeight: opts.compact ? 36 : 26,
    minWidth: opts.compact ? 36 : undefined,
    padding: opts.compact ? "0 12px" : "0 8px",
    borderRadius: 4,
    border: `1px solid ${opts.active ? colorAlpha.accentLine : colors.line}`,
    background: opts.active ? colorAlpha.accentSoft : colors.bg2,
    color: opts.danger ? colors.err : opts.active ? colors.accent : colors.fg1,
    fontFamily: MONO,
    fontSize: rem(12),
    cursor: "pointer",
    whiteSpace: "nowrap",
    flexShrink: 0,
  };
}

export function fieldStyle(compact?: boolean): CSSProperties {
  return {
    height: compact ? 36 : 28,
    padding: "0 8px",
    borderRadius: 4,
    border: `1px solid ${colors.line}`,
    background: colors.bg0,
    color: colors.fg0,
    fontFamily: MONO,
    // 16px on touch keeps iOS from zooming into the field.
    fontSize: compact ? "16px" : rem(12.5),
    outline: "none",
    boxSizing: "border-box",
    minWidth: 0,
  };
}

const openUrl = createExternalUrlOpener({
  isTauri,
  tauriOpenUrl: (url) => invokeTauri("plugin:opener|open_url", { url }),
  tauriShellOpen: (url) => invokeTauri("plugin:shell|open", { path: url }),
  windowOpen: (url) => {
    window.open(url, "_blank", "noopener,noreferrer");
  },
  canTrustWindowOpen: () =>
    typeof navigator === "undefined" || !/\bwv\b/.test(navigator.userAgent),
});

function invokeTauri(cmd: string, args: Record<string, unknown>): Promise<unknown> {
  const internals = (window as unknown as {
    __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
  }).__TAURI_INTERNALS__;
  if (!internals?.invoke) return Promise.reject(new Error("__TAURI_INTERNALS__ not available"));
  return internals.invoke(cmd, args);
}

/** Opens through the same channel the terminal's links use (Tauri opener, then window.open). */
export function openExternalLink(url: string): void {
  openUrl(url);
}

export function isLinkable(url: string): boolean {
  return isSafeExternalUrl(url);
}

/** Fixed-position popover anchored under an element; closes on outside press, Esc or scroll. */
export function Popover({
  anchor,
  onClose,
  children,
  width = 240,
  testId,
}: {
  anchor: HTMLElement | null;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  testId?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    if (!anchor || !ref.current) return;
    const r = anchor.getBoundingClientRect();
    const h = ref.current.offsetHeight;
    const w = Math.min(width, window.innerWidth - 16);
    let top = r.bottom + 2;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 2);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    setPos({ left, top });
  }, [anchor, width]);

  useEffect(() => {
    const onDown = (e: Event) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
    };
    const onScroll = (e: Event) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      closeRef.current();
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("touchstart", onDown, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("touchstart", onDown, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, []);

  return createPortal(
    <div
      ref={ref}
      data-testid={testId}
      style={{
        position: "fixed",
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        width: Math.min(width, typeof window === "undefined" ? width : window.innerWidth - 16),
        maxHeight: "min(360px, 60vh)",
        overflowY: "auto",
        zIndex: 120,
        background: colors.bg1,
        border: `1px solid ${colors.line}`,
        borderRadius: 6,
        boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
        color: colors.fg0,
        fontFamily: MONO,
        fontSize: rem(12.5),
        padding: 6,
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

/** Modal bottom sheet used on phones for the filter/sort builder. */
export function Sheet({
  title,
  onClose,
  children,
  testId,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  testId?: string;
}) {
  return createPortal(
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, zIndex: 120, background: "rgba(0,0,0,0.48)", display: "flex", alignItems: "flex-end" }}
    >
      <div
        data-testid={testId}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxHeight: "80vh",
          overflowY: "auto",
          background: colors.bg1,
          borderTop: `1px solid ${colors.line}`,
          borderRadius: "10px 10px 0 0",
          padding: 14,
          fontFamily: MONO,
          color: colors.fg0,
          boxSizing: "border-box",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
          <span style={{ flex: 1, fontSize: rem(13), fontWeight: 600 }}>{title}</span>
          <button type="button" onClick={onClose} style={smallBtn({ compact: true })}>
            done
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
