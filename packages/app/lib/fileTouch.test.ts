import { describe, expect, it } from "vitest";
import type { DirEntry } from "@offdesk/shared";
import {
  createClickSuppressor,
  FILE_LONG_PRESS_MS,
  FILE_LONG_PRESS_SLOP_PX,
  mobileBarActions,
  mobileMoreActions,
  pasteBarState,
  selectionTitle,
} from "./fileTouch";
import { createLongPressTracker } from "./longPress";

const file = (name: string): DirEntry =>
  ({ name, path: `/d/${name}`, is_dir: false, size: 1, modified_ms: 0 }) as DirEntry;
const dir = (name: string): DirEntry => ({ ...file(name), is_dir: true });
const ids = (actions: { id: string }[]) => actions.map((a) => a.id);

describe("long-press thresholds", () => {
  const setup = () => {
    let fire: (() => void) | null = null;
    const presses: unknown[] = [];
    const tracker = createLongPressTracker({
      onLongPress: (p) => presses.push(p),
      delayMs: FILE_LONG_PRESS_MS,
      slopPx: FILE_LONG_PRESS_SLOP_PX,
      setTimeoutFn: (fn, ms) => {
        expect(ms).toBe(450);
        fire = fn;
        return 1;
      },
      clearTimeoutFn: () => {
        fire = null;
      },
    });
    return { tracker, presses, fire: () => fire?.() };
  };
  const ev = (x: number, y: number) => ({ pointerId: 1, clientX: x, clientY: y });

  it("fires after the delay when the finger stays put", () => {
    const t = setup();
    t.tracker.pointerDown(ev(5, 5));
    t.tracker.pointerMove(ev(9, 9));
    t.fire();
    expect(t.presses).toHaveLength(1);
  });

  it("is cancelled by moving more than 10px", () => {
    const t = setup();
    t.tracker.pointerDown(ev(0, 0));
    t.tracker.pointerMove(ev(0, 11));
    t.fire();
    expect(t.presses).toHaveLength(0);
  });

  it("is cancelled by pointercancel (the browser starts scrolling)", () => {
    const t = setup();
    t.tracker.pointerDown(ev(0, 0));
    t.tracker.pointerCancel(ev(0, 0));
    t.fire();
    expect(t.presses).toHaveLength(0);
  });
});

describe("action bar", () => {
  it("offers rename only for one item", () => {
    expect(ids(mobileBarActions({ targets: [file("a")], canEdit: true }))).toEqual([
      "download", "move", "copy", "rename", "trash", "more",
    ]);
    expect(ids(mobileBarActions({ targets: [file("a"), file("b")], canEdit: true }))).toEqual([
      "download", "move", "copy", "trash", "more",
    ]);
  });

  it("hides mutating actions when files are view-only", () => {
    expect(ids(mobileBarActions({ targets: [file("a")], canEdit: false }))).toEqual(["download", "more"]);
  });

  it("labels folder/multi downloads as zip", () => {
    expect(mobileBarActions({ targets: [dir("a")], canEdit: true })[0].label).toBe("Zip");
    expect(mobileBarActions({ targets: [file("a")], canEdit: true })[0].label).toBe("Download");
  });

  it("builds the more sheet", () => {
    const base = { canEdit: true, canOpenTerminal: true, pinned: [] as string[] };
    expect(ids(mobileMoreActions({ ...base, targets: [dir("a")] }))).toEqual([
      "duplicate", "copy-path", "open-terminal", "pin",
    ]);
    expect(ids(mobileMoreActions({ ...base, targets: [file("a")] }))).toEqual([
      "duplicate", "copy-path", "open-terminal",
    ]);
    expect(ids(mobileMoreActions({ ...base, targets: [file("a"), file("b")] }))).toEqual([
      "duplicate", "copy-path",
    ]);
    expect(ids(mobileMoreActions({ ...base, canEdit: false, canOpenTerminal: false, targets: [file("a")] }))).toEqual([
      "copy-path",
    ]);
    expect(mobileMoreActions({ ...base, pinned: ["/d/a"], targets: [dir("a")] }).at(-1)?.label).toBe(
      "Remove from Places",
    );
  });
});

describe("paste bar", () => {
  const clip = { mode: "cut" as const, machineId: "m", paths: ["/d/a", "/d/b"] };
  it("is hidden without a clipboard, on another machine, or when view-only", () => {
    expect(pasteBarState(null, "m", "/x", true).visible).toBe(false);
    expect(pasteBarState(clip, "other", "/x", true).visible).toBe(false);
    expect(pasteBarState(clip, "m", "/x", false).visible).toBe(false);
  });
  it("counts items and checks the destination", () => {
    const s = pasteBarState(clip, "m", "/x", true);
    expect(s).toMatchObject({ visible: true, ok: true, label: "Paste 2 items here", verb: "Move" });
    expect(pasteBarState({ ...clip, paths: ["/d/a"], mode: "copy" }, "m", "/x", true).label).toBe("Paste 1 item here");
    const same = pasteBarState(clip, "m", "/d", true);
    expect(same.ok).toBe(false);
    expect(same.reason).toBe("Already in this folder");
  });
});

describe("click after long-press", () => {
  it("swallows exactly one click inside the window", () => {
    let t = 0;
    const s = createClickSuppressor(() => t);
    s.arm();
    t = 300;
    expect(s.consume()).toBe(true);
    expect(s.consume()).toBe(false);
  });
  it("lets a late click through", () => {
    let t = 0;
    const s = createClickSuppressor(() => t);
    s.arm();
    t = 2000;
    expect(s.consume()).toBe(false);
  });
});

it("titles the selection", () => {
  expect(selectionTitle(3)).toBe("3 selected");
});
