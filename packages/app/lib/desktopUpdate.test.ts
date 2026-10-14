import { describe, expect, it } from "vitest";

import { afterCheck, cardVisible, installsBeforeQuit, startOfNextDay, type DesktopUpdateState } from "./desktopUpdate";

const ready: DesktopUpdateState = {
  current: "0.9.0",
  available: "0.9.1",
  phase: "ready",
  checking: false,
  progress: null,
  error: null,
  message: null,
  checkedAt: 0,
  deferred: false,
  cardOpen: false,
  dismissed: null,
};

describe("the update card", () => {
  const now = new Date(2026, 9, 14, 15, 30).getTime();

  it("shows once the update has downloaded", () => {
    expect(cardVisible(ready, now)).toBe(true);
    expect(cardVisible({ ...ready, phase: "downloading" }, now)).toBe(false);
    expect(cardVisible({ ...ready, available: null, phase: "idle" }, now)).toBe(false);
  });

  it("stays dismissed until tomorrow, for that version only", () => {
    const dismissed = { version: "0.9.1", until: startOfNextDay(now) };
    expect(cardVisible({ ...ready, dismissed }, now)).toBe(false);
    expect(cardVisible({ ...ready, dismissed }, new Date(2026, 9, 15, 0, 0).getTime())).toBe(true);
    expect(cardVisible({ ...ready, available: "0.9.2", dismissed }, now)).toBe(true);
  });

  it("stays away after `when I quit` and once installed, unless asked for", () => {
    expect(cardVisible({ ...ready, deferred: true }, now)).toBe(false);
    expect(cardVisible({ ...ready, phase: "installed" }, now)).toBe(false);
    expect(cardVisible({ ...ready, phase: "installed", cardOpen: true }, now)).toBe(true);
    expect(cardVisible({ ...ready, dismissed: { version: "0.9.1", until: now + 1 }, cardOpen: true }, now)).toBe(true);
  });
});

describe("until tomorrow", () => {
  it("is the next local midnight", () => {
    const next = new Date(startOfNextDay(new Date(2026, 9, 14, 23, 59).getTime()));
    expect([next.getFullYear(), next.getMonth(), next.getDate(), next.getHours(), next.getMinutes()]).toEqual([2026, 9, 15, 0, 0]);
    expect(startOfNextDay(new Date(2026, 9, 14, 0, 0).getTime())).toBe(new Date(2026, 9, 15).getTime());
  });
});

describe("`when I quit`", () => {
  it("installs before the quit where the running app survives it", () => {
    expect(installsBeforeQuit("macos")).toBe(true);
    expect(installsBeforeQuit("linux")).toBe(true);
    expect(installsBeforeQuit("windows")).toBe(false);
    expect(installsBeforeQuit("unknown")).toBe(false);
  });
});

describe("a check", () => {
  it("leaves a downloaded or installed update showing instead of flickering", () => {
    expect(afterCheck({ phase: "ready", available: "0.9.1" }, "0.9.1", true)).toBe("keep");
    expect(afterCheck({ phase: "installed", available: "0.9.1" }, "0.9.1", false)).toBe("keep");
    // Installed stays installed, even when something newer is out: the
    // restart comes first.
    expect(afterCheck({ phase: "installed", available: "0.9.1" }, "0.9.2", false)).toBe("keep");
    expect(afterCheck({ phase: "installed", available: "0.9.1" }, null, false)).toBe("keep");
  });

  it("downloads what is new or not here yet, and forgets an offer that is gone", () => {
    expect(afterCheck({ phase: "idle", available: null }, "0.9.1", false)).toBe("download");
    expect(afterCheck({ phase: "ready", available: "0.9.1" }, "0.9.2", true)).toBe("download");
    // Reloaded window: the offer is known but its bytes are not here.
    expect(afterCheck({ phase: "ready", available: "0.9.1" }, "0.9.1", false)).toBe("download");
    expect(afterCheck({ phase: "ready", available: "0.9.1" }, null, true)).toBe("none");
  });
});
