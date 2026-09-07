import { useState, useEffect } from "react";
import { Dimensions, Platform } from "react-native";

import {
  classifyDisplayMode,
  detectIsTouch,
  COMPACT_WINDOW_WIDTH_PX,
  type DisplayMode,
} from "./displayMode";

function readNativeDisplayMode(): DisplayMode {
  return {
    isTouch: true,
    isCompact: Dimensions.get("window").width <= COMPACT_WINDOW_WIDTH_PX,
  };
}

function readWebDisplayMode(): DisplayMode {
  if (typeof window === "undefined") {
    return { isCompact: false, isTouch: false };
  }
  return classifyDisplayMode({
    isTouch: detectIsTouch(),
    screenWidth: window.screen.width,
    screenHeight: window.screen.height,
    windowWidth: window.innerWidth,
  });
}

function readDisplayMode(): DisplayMode {
  if (Platform.OS !== "web") return readNativeDisplayMode();
  return readWebDisplayMode();
}

/**
 * Subscribes to window resize and `(pointer: coarse)` changes so Fold
 * fold/unfold (which fires resize and updates screen dims) reclassifies.
 * Native keeps the legacy window-width compact check and always reports touch.
 */
export function useDisplayMode(): DisplayMode {
  const [mode, setMode] = useState<DisplayMode>(readDisplayMode);

  useEffect(() => {
    const commit = (next: DisplayMode) => {
      setMode((prev) =>
        prev.isCompact === next.isCompact && prev.isTouch === next.isTouch
          ? prev
          : next,
      );
    };
    if (Platform.OS === "web" && typeof window !== "undefined") {
      const update = () => commit(readWebDisplayMode());
      window.addEventListener("resize", update);
      let mql: MediaQueryList | null = null;
      if (typeof window.matchMedia === "function") {
        mql = window.matchMedia("(pointer: coarse)");
        mql.addEventListener("change", update);
      }
      update();
      return () => {
        window.removeEventListener("resize", update);
        mql?.removeEventListener("change", update);
      };
    }

    const sub = Dimensions.addEventListener("change", ({ window: win }) => {
      commit({
        isTouch: true,
        isCompact: win.width <= COMPACT_WINDOW_WIDTH_PX,
      });
    });
    return () => sub.remove();
  }, []);

  return mode;
}

/**
 * Web-only. Tracks `window.visualViewport.height` so layouts can shrink when
 * the mobile soft keyboard opens (dvh/vh units don't react to it). Returns
 * `null` if `visualViewport` is unavailable — callers should fall back to
 * `100dvh` or similar in that case.
 */
interface VisualViewportBounds {
  height: number;
  offsetTop: number;
  scale: number;
}

export function useVisualViewport(): VisualViewportBounds | null {
  const [bounds, setBounds] = useState<VisualViewportBounds | null>(() => {
    if (
      Platform.OS !== "web" ||
      typeof window === "undefined" ||
      !window.visualViewport
    ) {
      return null;
    }
    const vv = window.visualViewport;
    return { height: vv.height, offsetTop: vv.offsetTop, scale: vv.scale };
  });

  useEffect(() => {
    if (
      Platform.OS !== "web" ||
      typeof window === "undefined" ||
      !window.visualViewport
    ) {
      return;
    }
    const vv = window.visualViewport;
    const update = () => setBounds({ height: vv.height, offsetTop: vv.offsetTop, scale: vv.scale });
    update();
    vv.addEventListener("resize", update);
    // iOS Safari fires `scroll` — not `resize` — when the keyboard shifts.
    vv.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  return bounds;
}

export function useVisualViewportHeight(): number | null {
  return useVisualViewport()?.height ?? null;
}
