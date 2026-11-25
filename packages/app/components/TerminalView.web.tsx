import { forwardRef, lazy, Suspense, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { TerminalViewRef, TerminalViewProps } from "./TerminalView.types";
import { LazyLoadingFallback } from "./LazyLoadingFallback";
import { lazyWithReload } from "@/lib/lazyWithReload";
import { isTauri } from "@/lib/platform";

const LazyXtermImpl = lazy(() =>
  lazyWithReload(() =>
    import("./TerminalView.xterm").then((m) => ({ default: m.TerminalView })),
  ),
);

const LazyNativeImpl = lazy(() =>
  lazyWithReload(() =>
    import("./TerminalView.native").then((m) => ({ default: m.TerminalView })),
  ),
);

export const TERMINAL_RENDERER_STORAGE_KEY = "offdesk:terminalRenderer";

let cachedNativeProbe: boolean | null = null;
let nativeProbePromise: Promise<boolean> | null = null;

function probeNativeTerminalIpc(): Promise<boolean> {
  if (cachedNativeProbe !== null) return Promise.resolve(cachedNativeProbe);
  if (!isTauri()) {
    cachedNativeProbe = false;
    return Promise.resolve(false);
  }
  if (!nativeProbePromise) {
    nativeProbePromise = invoke("native_term_close", { id: "__probe__" })
      .then(() => {
        cachedNativeProbe = true;
        return true;
      })
      .catch(() => {
        cachedNativeProbe = false;
        return false;
      });
  }
  return nativeProbePromise;
}

export function useNativeRustTerminal(): boolean {
  const optedOut = (() => {
    try {
      return window.localStorage.getItem(TERMINAL_RENDERER_STORAGE_KEY) === "xterm";
    } catch {
      return false;
    }
  })();

  const [available, setAvailable] = useState<boolean>(() => {
    if (!isTauri() || optedOut) return false;
    return cachedNativeProbe === true;
  });

  useEffect(() => {
    if (!isTauri() || optedOut) {
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
  }, [optedOut]);

  return available;
}

export type { TerminalViewRef, TerminalViewProps };

export const TerminalView = forwardRef<TerminalViewRef, TerminalViewProps>(
  function TerminalView(props, ref) {
    const Impl = useNativeRustTerminal() ? LazyNativeImpl : LazyXtermImpl;
    return (
      <Suspense fallback={<LazyLoadingFallback />}>
        <Impl ref={ref} {...props} />
      </Suspense>
    );
  },
);
