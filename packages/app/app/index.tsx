import { lazy, Suspense } from "react";
import { LazyLoadingFallback } from "@/components/LazyLoadingFallback";
import { lazyWithReload } from "@/lib/lazyWithReload";

const WebTerminalCanvas = lazy(() =>
  lazyWithReload(() =>
    import("../components/TerminalCanvas.web").then((module) => ({
      default: module.TerminalCanvas,
    })),
  ),
);

export default function HomeScreen() {
  return (
    <Suspense fallback={<LazyLoadingFallback />}>
      <WebTerminalCanvas />
    </Suspense>
  );
}
