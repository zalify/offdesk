import { describe, expect, it } from "vitest";

import {
  readSidebarHoverPreferences,
  SIDEBAR_HOVER_SPACE_KEY,
  SIDEBAR_HOVER_TERMINAL_KEY,
  writeSidebarHoverPreferences,
} from "./sidebarHoverPreferences";

function makeMemoryStorage(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

describe("sidebarHoverPreferences", () => {
  it("defaults both hover-to-switch preferences to true", () => {
    const storage = makeMemoryStorage();
    expect(readSidebarHoverPreferences(storage)).toEqual({
      hoverSwitchSpace: true,
      hoverSwitchTerminal: true,
    });
  });

  it("persists and reads back individual toggles", () => {
    const storage = makeMemoryStorage();
    expect(
      writeSidebarHoverPreferences({ hoverSwitchSpace: false }, storage),
    ).toEqual({
      hoverSwitchSpace: false,
      hoverSwitchTerminal: true,
    });
    expect(storage.getItem(SIDEBAR_HOVER_SPACE_KEY)).toBe("0");

    expect(
      writeSidebarHoverPreferences({ hoverSwitchTerminal: false }, storage),
    ).toEqual({
      hoverSwitchSpace: false,
      hoverSwitchTerminal: false,
    });
    expect(storage.getItem(SIDEBAR_HOVER_TERMINAL_KEY)).toBe("0");

    expect(
      writeSidebarHoverPreferences({ hoverSwitchSpace: true }, storage),
    ).toEqual({
      hoverSwitchSpace: true,
      hoverSwitchTerminal: false,
    });
    expect(readSidebarHoverPreferences(storage)).toEqual({
      hoverSwitchSpace: true,
      hoverSwitchTerminal: false,
    });
  });

  it("falls back to defaults when storage is unavailable or contains unknown values", () => {
    expect(readSidebarHoverPreferences(null)).toEqual({
      hoverSwitchSpace: true,
      hoverSwitchTerminal: true,
    });
    const weird = makeMemoryStorage({
      [SIDEBAR_HOVER_SPACE_KEY]: "invalid",
      [SIDEBAR_HOVER_TERMINAL_KEY]: "false",
    });
    expect(readSidebarHoverPreferences(weird)).toEqual({
      hoverSwitchSpace: true,
      hoverSwitchTerminal: false,
    });
  });
});
