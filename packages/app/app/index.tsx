import { lazy, Suspense } from "react";
import { BootScreen } from "@/components/BootScreen.web";
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
    <Suspense fallback={<BootScreen step="hub" />}>
      <WebTerminalCanvas />
    </Suspense>
  );
}
