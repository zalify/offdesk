import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  activateGpuRenderer,
  ATLAS_CLEAR_INTERVAL_MS,
  RENDERER_STORAGE_KEY,
} from "./terminalGpuRenderer";

interface FakeAddon {
  onContextLoss(listener: () => void): { dispose(): void };
  dispose(): void;
}

function makeFakeTerminal() {
  return {
    loadedAddons: [] as FakeAddon[],
    atlasClears: 0,
    loadAddon(addon: FakeAddon) {
      this.loadedAddons.push(addon);
    },
    clearTextureAtlas() {
      this.atlasClears += 1;
    },
  };
}

function makeFakeAddon() {
  const addon = {
    disposed: false,
    contextLossListeners: [] as Array<() => void>,
    onContextLoss(listener: () => void) {
      addon.contextLossListeners.push(listener);
      return {
        dispose() {
          const index = addon.contextLossListeners.indexOf(listener);
          if (index >= 0) addon.contextLossListeners.splice(index, 1);
        },
      };
    },
    dispose() {
      addon.disposed = true;
    },
    loseContext() {
      for (const listener of [...addon.contextLossListeners]) listener();
    },
  };
  return addon;
}

describe("activateGpuRenderer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads the addon and reports active", () => {
    const term = makeFakeTerminal();
    const addon = makeFakeAddon();
    const handle = activateGpuRenderer(term, {
      createAddon: () => addon,
      storage: null,
    });
    expect(handle.isActive()).toBe(true);
    expect(term.loadedAddons).toEqual([addon]);
    handle.dispose();
    expect(addon.disposed).toBe(true);
    expect(handle.isActive()).toBe(false);
  });

  it("stays on the DOM renderer when addon construction throws", () => {
    const term = makeFakeTerminal();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handle = activateGpuRenderer(term, {
      createAddon: () => {
        throw new Error("no webgl context");
      },
      storage: null,
    });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    expect(handle.isActive()).toBe(false);
    expect(term.loadedAddons).toEqual([]);
    // Never schedules the atlas timer.
    vi.advanceTimersByTime(ATLAS_CLEAR_INTERVAL_MS * 3);
    expect(term.atlasClears).toBe(0);
  });

  it("falls back to the DOM renderer on WebGL context loss", () => {
    const term = makeFakeTerminal();
    const addon = makeFakeAddon();
    const handle = activateGpuRenderer(term, {
      createAddon: () => addon,
      storage: null,
    });
    addon.loseContext();
    expect(handle.isActive()).toBe(false);
    expect(addon.disposed).toBe(true);
    // Atlas timer is stopped along with the addon.
    vi.advanceTimersByTime(ATLAS_CLEAR_INTERVAL_MS * 3);
    expect(term.atlasClears).toBe(0);
  });

  it("clears the texture atlas on the guard interval while active", () => {
    const term = makeFakeTerminal();
    const handle = activateGpuRenderer(term, {
      createAddon: () => makeFakeAddon(),
      storage: null,
    });
    vi.advanceTimersByTime(ATLAS_CLEAR_INTERVAL_MS * 2 + 1);
    expect(term.atlasClears).toBe(2);
    handle.dispose();
    vi.advanceTimersByTime(ATLAS_CLEAR_INTERVAL_MS * 2);
    expect(term.atlasClears).toBe(2);
  });

  it("respects the offdesk:renderer=dom escape hatch", () => {
    const term = makeFakeTerminal();
    const handle = activateGpuRenderer(term, {
      createAddon: () => makeFakeAddon(),
      storage: {
        getItem: (key: string) =>
          key === RENDERER_STORAGE_KEY ? "dom" : null,
      },
    });
    expect(handle.isActive()).toBe(false);
    expect(term.loadedAddons).toEqual([]);
  });

  it("double dispose and dispose-after-context-loss are safe", () => {
    const term = makeFakeTerminal();
    const addon = makeFakeAddon();
    const handle = activateGpuRenderer(term, {
      createAddon: () => addon,
      storage: null,
    });
    addon.loseContext();
    handle.dispose();
    handle.dispose();
    expect(handle.isActive()).toBe(false);
  });

  it("recovers WebGL via ensureActive after context loss, but not after dispose", () => {
    const term = makeFakeTerminal();
    const first = makeFakeAddon();
    const second = makeFakeAddon();
    let count = 0;
    const handle = activateGpuRenderer(term, {
      createAddon: () => (++count === 1 ? first : second),
      storage: null,
    });
    expect(handle.isActive()).toBe(true);
    first.loseContext();
    expect(handle.isActive()).toBe(false);

    expect(handle.ensureActive()).toBe(true);
    expect(handle.isActive()).toBe(true);
    expect(term.loadedAddons).toEqual([first, second]);

    handle.dispose();
    expect(handle.ensureActive()).toBe(false);
    expect(handle.isActive()).toBe(false);
  });
});
