import { forwardRef, lazy, Suspense } from "react";
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

export function useNativeRustTerminal(): boolean {
  if (!isTauri()) return false;
  try {
    const pref = window.localStorage.getItem(TERMINAL_RENDERER_STORAGE_KEY);
    // Default to xterm until user opts in or flips switch, OR default to native in Tauri:
    return pref !== "xterm";
  } catch {
    return true;
  }
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
