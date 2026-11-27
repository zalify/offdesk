// GPU (WebGL) renderer activation for live terminals.
//
// History: the WebGL addon was removed in PR #230 (2026-06) because
// @xterm/addon-webgl's glyph texture atlas corrupts after roughly 120k
// unique atlas entries — sustained CJK output (Chinese Claude Code
// sessions) hits it deterministically, rendering sentinel glyphs as
// colored fragments of other glyphs. `clearTextureAtlas()` fully heals
// the corruption (that's why switching windows used to "fix" it). The
// bug is upstream and still unfixed as of 0.19/0.20-beta.
//
// The DOM renderer this left us with is an order of magnitude slower on
// high-throughput output, so this module brings WebGL back behind three
// guards instead of banning it:
//
//   1. Activation is best-effort: any construct/load failure leaves the
//      DOM renderer in place silently.
//   2. WebGL context loss disposes the addon → xterm falls back to the
//      DOM renderer on its own.
//   3. The texture atlas is cleared on a fixed interval, keeping the
//      entry count far below the corruption threshold. A clear costs one
//      re-rasterization of the visible screen — invisible next to the
//      corruption it prevents.
//
// Escape hatch: localStorage "offdesk:renderer" = "dom" skips activation
// entirely (diagnosis / rollback without a deploy).
import type { Terminal } from "@xterm/xterm";
import { WebglAddon } from "@xterm/addon-webgl";

export const RENDERER_STORAGE_KEY = "offdesk:renderer";
export const ATLAS_CLEAR_INTERVAL_MS = 5 * 60_000;

interface WebglAddonLike {
  onContextLoss(listener: () => void): { dispose(): void };
  dispose(): void;
}

interface TerminalLike {
  loadAddon(addon: WebglAddonLike): void;
  clearTextureAtlas(): void;
}

export interface GpuRendererHandle {
  /** True while the WebGL addon is driving rendering. */
  isActive(): boolean;
  /** Re-attempt WebGL activation after a context loss (no-op if already active,
   * disposed, or opted out via offdesk:renderer=dom). */
  ensureActive(): boolean;
  dispose(): void;
}

export interface ActivateGpuRendererOptions {
  /** Injection point for tests. Defaults to `new WebglAddon()`. */
  createAddon?: () => WebglAddonLike;
  /** Injection point for tests. Defaults to ATLAS_CLEAR_INTERVAL_MS. */
  atlasClearIntervalMs?: number;
  /** Injection point for tests. Defaults to localStorage. */
  storage?: Pick<Storage, "getItem"> | null;
}

const INERT_HANDLE: GpuRendererHandle = {
  isActive: () => false,
  ensureActive: () => false,
  dispose: () => {},
};

function defaultStorage(): Pick<Storage, "getItem"> | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function activateGpuRenderer(
  term: TerminalLike | Terminal,
  options: ActivateGpuRendererOptions = {},
): GpuRendererHandle {
  const storage =
    options.storage !== undefined ? options.storage : defaultStorage();
  try {
    if (storage?.getItem(RENDERER_STORAGE_KEY) === "dom") {
      return INERT_HANDLE;
    }
  } catch {
    // Storage denied (private mode etc.) — fall through and try WebGL.
  }

  let addon: WebglAddonLike | null = null;
  let contextLossSubscription: { dispose(): void } | null = null;
  let atlasTimer: ReturnType<typeof setInterval> | null = null;
  let active = false;
  let permanentlyDisposed = false;
  let lostContext = false;

  const deactivate = () => {
    if (!active) return;
    active = false;
    if (atlasTimer !== null) {
      clearInterval(atlasTimer);
      atlasTimer = null;
    }
    contextLossSubscription?.dispose();
    contextLossSubscription = null;
    try {
      addon?.dispose();
    } catch {
      // Already disposed by xterm (e.g. terminal teardown raced us).
    }
    addon = null;
  };

  const tryActivate = (): boolean => {
    if (permanentlyDisposed || active) return active;
    try {
      addon = options.createAddon
        ? options.createAddon()
        : (new WebglAddon() as WebglAddonLike);
      // Subscribe before loadAddon: a context lost during activation must
      // still trigger the fallback.
      contextLossSubscription = addon.onContextLoss(() => {
        // Disposing the addon makes xterm fall back to the DOM renderer.
        // Mark lostContext so the pane can recover WebGL when re-focused.
        lostContext = true;
        deactivate();
      });
      (term as TerminalLike).loadAddon(addon);
      active = true;
      lostContext = false;
    } catch (error) {
      contextLossSubscription?.dispose();
      contextLossSubscription = null;
      addon = null;
      // Silent fallback is the contract, but a construct/load miss has to
      // be visible in e2e/browser consoles or the canvas canary is the
      // only signal that we dropped to the DOM renderer.
      console.warn("[offdesk] WebGL renderer unavailable, using DOM", error);
      return false;
    }

    atlasTimer = setInterval(() => {
      try {
        (term as TerminalLike).clearTextureAtlas();
      } catch {
        // A disposed terminal can't clear an atlas; stop trying.
        deactivate();
      }
    }, options.atlasClearIntervalMs ?? ATLAS_CLEAR_INTERVAL_MS);

    return true;
  };

  if (!tryActivate()) {
    return INERT_HANDLE;
  }

  return {
    isActive: () => active,
    ensureActive: () => {
      if (permanentlyDisposed || active || !lostContext) return active;
      return tryActivate();
    },
    dispose: () => {
      permanentlyDisposed = true;
      deactivate();
    },
  };
}
