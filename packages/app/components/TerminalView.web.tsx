import { forwardRef, lazy, Suspense, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { TerminalViewRef, TerminalViewProps } from "./TerminalView.types";
import { LazyLoadingFallback } from "./LazyLoadingFallback";
import { lazyWithReload } from "@/lib/lazyWithReload";
import { isTauri, isTauriMobile } from "@/lib/platform";

const LazyXtermImpl = lazy(() =>
  lazyWithReload(() =>
    import("./TerminalView.xterm").then((m) => ({ default: m.TerminalView })),
  ),
);

const loadNativeImpl = () =>
  lazyWithReload(() =>
    import("./TerminalView.native").then((m) => ({ default: m.TerminalView })),
  );

const LazyNativeImpl = lazy(loadNativeImpl);

export const TERMINAL_RENDERER_STORAGE_KEY = "offdesk:terminalRenderer";

/**
 * Desktop Tauri defaults to Native Rust (alacritty_terminal).
 * Mobile Tauri (iOS / Android) defaults to xterm.js because xterm.js carries
 * full mobile touch scrolling, Android/iOS IME composition patches, local echo,
 * and mobile viewport/keyboard fitting — unless the user explicitly selects
 * "native" in Settings.
 */
export function shouldPreferNativeRenderer(): boolean {
  if (typeof window === "undefined" || !isTauri()) return false;
  let pref: string | null = null;
  try {
    pref = window.localStorage.getItem(TERMINAL_RENDERER_STORAGE_KEY);
  } catch {
    pref = null;
  }
  if (pref === "xterm") return false;
  if (pref === "native") return true;
  return !isTauriMobile();
}

let cachedNativeProbe: boolean | null = null;
let cachedNativeProbeError: string | null = null;
let nativeProbePromise: Promise<boolean> | null = null;

// Eagerly kick off IPC probe + native module preload at boot so the first
// terminal mount has zero probe latency and zero Suspense chunk stall.
if (shouldPreferNativeRenderer()) {
  void loadNativeImpl();
  void Promise.resolve().then(() => probeNativeTerminalIpc());
}

function probeNativeTerminalIpc(): Promise<boolean> {
  if (cachedNativeProbe !== null) return Promise.resolve(cachedNativeProbe);
  if (!isTauri()) {
    cachedNativeProbe = false;
    cachedNativeProbeError = "not running inside Tauri shell";
    return Promise.resolve(false);
  }
  if (!nativeProbePromise) {
    nativeProbePromise = invoke<{ cols?: unknown; spans?: unknown } | null>("native_term_open", {
      id: "__probe__",
      cols: 2,
      rows: 2,
    })
      .then((res) => {
        const ok = Boolean(res && typeof res.cols === "number" && Array.isArray(res.spans));
        if (ok) {
          void invoke("native_term_close", { id: "__probe__" }).catch(() => {});
          cachedNativeProbeError = null;
        } else {
          cachedNativeProbeError = "unexpected native_term_open response";
        }
        cachedNativeProbe = ok;
        return ok;
      })
      .catch((err) => {
        cachedNativeProbe = false;
        cachedNativeProbeError = err instanceof Error ? err.message : String(err);
        return false;
      });
  }
  return nativeProbePromise;
}

export function useNativeTerminalProbeStatus(): {
  probed: boolean;
  available: boolean;
  error: string | null;
} {
  const [state, setState] = useState<{ probed: boolean; available: boolean; error: string | null }>(
    () => ({
      probed: cachedNativeProbe !== null,
      available: cachedNativeProbe === true,
      error: cachedNativeProbeError,
    }),
  );
  useEffect(() => {
    if (cachedNativeProbe !== null) {
      setState({ probed: true, available: cachedNativeProbe, error: cachedNativeProbeError });
      return;
    }
    let alive = true;
    void probeNativeTerminalIpc().then((ok) => {
      if (alive) {
        setState({ probed: true, available: ok, error: cachedNativeProbeError });
      }
    });
    return () => {
      alive = false;
    };
  }, []);
  return state;
}

export function useNativeRustTerminal(): boolean | null {
  const preferNative = shouldPreferNativeRenderer();

  const [available, setAvailable] = useState<boolean | null>(() => {
    if (!preferNative) return false;
    return cachedNativeProbe;
  });

  useEffect(() => {
    if (!preferNative) {
      setAvailable(false);
      return;
    }
    let alive = true;
    void probeNativeTerminalIpc().then((ok) => {
      if (alive) setAvailable(ok);
    });
    return () => {
      alive = false;
    };
  }, [preferNative]);

  return available;
}

export type { TerminalViewRef, TerminalViewProps };

export const TerminalView = forwardRef<TerminalViewRef, TerminalViewProps>(
  function TerminalView(props, ref) {
    const nativeAvailable = useNativeRustTerminal();
    if (nativeAvailable === null) {
      return <LazyLoadingFallback />;
    }
    const Impl = nativeAvailable ? LazyNativeImpl : LazyXtermImpl;
    return (
      <Suspense fallback={<LazyLoadingFallback />}>
        <Impl ref={ref} {...props} />
      </Suspense>
    );
  },
);
