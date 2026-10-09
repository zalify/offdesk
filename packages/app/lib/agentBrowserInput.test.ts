import { describe, expect, it } from "vitest";
import {
  IDENTITY_VIEW_ZOOM,
  browserShortcut,
  classifyTouchGesture,
  clampViewZoom,
  compositionEndAction,
  dragWheelEvent,
  isDoubleTap,
  mapZoomedClientPointToViewport,
  panViewBy,
  pinchViewZoom,
  softInputAction,
  softKeyEvents,
  tapEvents,
  toggleViewZoomAt,
  unzoomClientPoint,
  viewportPerClientPx,
  zoomViewAt,
  containedImageRect,
  isComposingKey,
  keyEvent,
  mapClientPointToViewport,
  mouseEvent,
  modifiersOf,
  parseFrameMeta,
  textEvent,
  wheelEvent,
} from "./agentBrowserInput";

const noMods = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };

describe("mapClientPointToViewport", () => {
  it("maps a pane of the same aspect without bars", () => {
    const rect = { left: 100, top: 50, width: 640, height: 400 };
    expect(mapClientPointToViewport(100, 50, rect, 1280, 800)).toEqual({ x: 0, y: 0 });
    expect(mapClientPointToViewport(420, 250, rect, 1280, 800)).toEqual({ x: 640, y: 400 });
    expect(mapClientPointToViewport(740, 450, rect, 1280, 800)).toEqual({ x: 1280, y: 800 });
  });

  it("letterboxes horizontally when the pane is wider than the image", () => {
    // 1600x800 pane: the 2:1.25 image is 1280x800 centered, 160 px bars.
    const rect = { left: 0, top: 0, width: 1600, height: 800 };
    expect(mapClientPointToViewport(100, 400, rect, 1280, 800)).toBeNull();
    expect(mapClientPointToViewport(1500, 400, rect, 1280, 800)).toBeNull();
    expect(mapClientPointToViewport(160, 0, rect, 1280, 800)).toEqual({ x: 0, y: 0 });
    expect(mapClientPointToViewport(800, 400, rect, 1280, 800)).toEqual({ x: 640, y: 400 });
  });

  it("letterboxes vertically when the pane is taller than the image", () => {
    // 640x600 pane: image is 640x400, bars of 100 px top and bottom.
    const rect = { left: 10, top: 20, width: 640, height: 600 };
    expect(mapClientPointToViewport(300, 60, rect, 1280, 800)).toBeNull();
    expect(mapClientPointToViewport(300, 600, rect, 1280, 800)).toBeNull();
    expect(mapClientPointToViewport(330, 320, rect, 1280, 800)).toEqual({ x: 640, y: 400 });
  });

  it("uses the viewport size from the meta, not the stream size", () => {
    // A 640x400 frame of the 1280x800 viewport, drawn 1:1 in the pane.
    const rect = { left: 0, top: 0, width: 640, height: 400 };
    const meta = { deviceWidth: 1280, deviceHeight: 800, pageScaleFactor: 1, offsetTop: 0 };
    expect(mapClientPointToViewport(320, 200, rect, 640, 400, meta)).toEqual({ x: 640, y: 400 });
    expect(mapClientPointToViewport(50, 30, rect, 640, 400, meta)).toEqual({ x: 100, y: 60 });
    // Without a meta the fixed viewport applies.
    expect(mapClientPointToViewport(50, 30, rect, 640, 400)).toEqual({ x: 100, y: 60 });
  });

  it("accounts for page zoom", () => {
    const rect = { left: 0, top: 0, width: 1280, height: 800 };
    expect(
      mapClientPointToViewport(1280, 800, rect, 1280, 800, {
        deviceWidth: 1280,
        deviceHeight: 800,
        pageScaleFactor: 2,
      }),
    ).toEqual({ x: 640, y: 400 });
  });

  it("returns null for an empty rect or frame", () => {
    expect(mapClientPointToViewport(0, 0, { left: 0, top: 0, width: 0, height: 0 }, 10, 10)).toBeNull();
    expect(mapClientPointToViewport(0, 0, { left: 0, top: 0, width: 10, height: 10 }, 0, 0)).toBeNull();
    expect(containedImageRect({ left: 0, top: 0, width: 10, height: 10 }, 0, 5)).toBeNull();
  });
});

describe("parseFrameMeta", () => {
  it("parses JSON and rejects junk", () => {
    const bytes = new TextEncoder().encode('{"deviceWidth":1280,"pageScaleFactor":1}');
    expect(parseFrameMeta(bytes)).toEqual({ deviceWidth: 1280, pageScaleFactor: 1 });
    expect(parseFrameMeta(new TextEncoder().encode("nope"))).toBeNull();
  });
});

describe("events", () => {
  it("builds the CDP modifier bitmask", () => {
    expect(modifiersOf(noMods)).toBe(0);
    expect(modifiersOf({ ...noMods, altKey: true })).toBe(1);
    expect(modifiersOf({ ...noMods, ctrlKey: true })).toBe(2);
    expect(modifiersOf({ ...noMods, metaKey: true })).toBe(4);
    expect(modifiersOf({ ...noMods, shiftKey: true })).toBe(8);
    expect(modifiersOf({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true })).toBe(15);
  });

  it("maps mouse buttons and click counts", () => {
    const point = { x: 5, y: 6 };
    expect(mouseEvent("down", point, { ...noMods, button: 0, buttons: 1, detail: 2 })).toEqual({
      kind: "mouse",
      action: "down",
      x: 5,
      y: 6,
      button: "left",
      buttons: 1,
      click_count: 2,
      modifiers: 0,
    });
    expect(mouseEvent("up", point, { ...noMods, button: 2, buttons: 0, detail: 0 })).toMatchObject({
      button: "right",
      click_count: 1,
    });
    expect(mouseEvent("down", point, { ...noMods, button: 1, buttons: 4, detail: 1 })).toMatchObject({
      button: "middle",
    });
    expect(mouseEvent("move", point, { ...noMods, button: 0, buttons: 1, detail: 3 })).toMatchObject({
      button: "none",
      buttons: 1,
      click_count: 0,
    });
  });

  it("converts wheel deltas by delta mode", () => {
    const point = { x: 1, y: 2 };
    expect(wheelEvent(point, { ...noMods, deltaX: 0, deltaY: 100, deltaMode: 0 })).toMatchObject({
      kind: "wheel",
      delta_y: 100,
    });
    expect(wheelEvent(point, { ...noMods, deltaX: 0, deltaY: 3, deltaMode: 1 })).toMatchObject({
      delta_y: 120,
    });
    expect(wheelEvent(point, { ...noMods, deltaX: 0, deltaY: 1, deltaMode: 2 })).toMatchObject({
      delta_y: 800,
    });
  });
});

describe("keyEvent", () => {
  const base = { ...noMods, key: "a", code: "KeyA", keyCode: 65 };

  it("carries text only for printable single characters", () => {
    expect(keyEvent("down", base)).toEqual({
      kind: "key",
      action: "down",
      key: "a",
      code: "KeyA",
      modifiers: 0,
      text: "a",
      key_code: 65,
    });
    expect(keyEvent("down", { ...base, key: "A", shiftKey: true })).toMatchObject({
      text: "A",
      modifiers: 8,
    });
    expect(keyEvent("down", { ...base, key: "é", keyCode: 0 })).toMatchObject({ text: "é" });
    expect(keyEvent("down", { ...base, key: "Enter", code: "Enter", keyCode: 13 }).kind).toBe("key");
    expect(keyEvent("down", { ...base, key: "Enter", code: "Enter", keyCode: 13 })).not.toHaveProperty("text");
    expect(keyEvent("down", { ...base, key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 })).not.toHaveProperty("text");
    expect(keyEvent("down", { ...base, key: " ", code: "Space", keyCode: 32 })).toMatchObject({ text: " " });
  });

  it("drops text with Ctrl or Meta held", () => {
    expect(keyEvent("down", { ...base, ctrlKey: true })).not.toHaveProperty("text");
    expect(keyEvent("down", { ...base, metaKey: true })).not.toHaveProperty("text");
    expect(keyEvent("down", { ...base, ctrlKey: true })).toMatchObject({ modifiers: 2 });
    expect(keyEvent("down", { ...base, altKey: true })).toMatchObject({ text: "a", modifiers: 1 });
  });

  it("omits key_code when unknown and never adds text on key up beyond the same rules", () => {
    expect(keyEvent("up", { ...base, keyCode: undefined })).not.toHaveProperty("key_code");
    expect(keyEvent("up", base)).toMatchObject({ action: "up" });
  });

  it("detects IME composition", () => {
    expect(isComposingKey({ ...base, isComposing: true })).toBe(true);
    expect(isComposingKey({ ...base, keyCode: 229 })).toBe(true);
    expect(isComposingKey(base)).toBe(false);
  });

  it("textEvent skips empty text", () => {
    expect(textEvent("")).toBeNull();
    expect(textEvent("你好")).toEqual({ kind: "text", text: "你好" });
  });
});

describe("browserShortcut", () => {
  const key = (key: string, mods: Partial<typeof noMods> = {}, code = "") => ({
    ...noMods,
    ...mods,
    key,
    code,
  });

  it("maps Chrome's Mac shortcuts on a Mac", () => {
    expect(browserShortcut(key("[", { metaKey: true }, "BracketLeft"), true)).toBe("back");
    expect(browserShortcut(key("]", { metaKey: true }, "BracketRight"), true)).toBe("forward");
    expect(browserShortcut(key("r", { metaKey: true }), true)).toBe("reload");
    expect(browserShortcut(key("L", { metaKey: true }), true)).toBe("address");
    expect(browserShortcut(key("F5"), true)).toBe("reload");
    // A non-US layout still has the bracket keys by position.
    expect(browserShortcut(key("ü", { metaKey: true }, "BracketLeft"), true)).toBe("back");
  });

  it("leaves Option+arrows, Ctrl+L and other chords to the page on a Mac", () => {
    expect(browserShortcut(key("ArrowLeft", { altKey: true }), true)).toBeNull();
    expect(browserShortcut(key("l", { ctrlKey: true }), true)).toBeNull();
    expect(browserShortcut(key("r", { ctrlKey: true }), true)).toBeNull();
    expect(browserShortcut(key("a", { metaKey: true }), true)).toBeNull();
    expect(browserShortcut(key("r", { metaKey: true, shiftKey: true }), true)).toBeNull();
  });

  it("maps Chrome's shortcuts elsewhere", () => {
    expect(browserShortcut(key("ArrowLeft", { altKey: true }), false)).toBe("back");
    expect(browserShortcut(key("ArrowRight", { altKey: true }), false)).toBe("forward");
    expect(browserShortcut(key("r", { ctrlKey: true }), false)).toBe("reload");
    expect(browserShortcut(key("l", { ctrlKey: true }), false)).toBe("address");
    expect(browserShortcut(key("F5", { ctrlKey: true }), false)).toBe("reload");
    expect(browserShortcut(key("[", { ctrlKey: true }), false)).toBeNull();
    expect(browserShortcut(key("[", { metaKey: true }), false)).toBeNull();
    expect(browserShortcut(key("a"), false)).toBeNull();
  });
});

describe("view zoom", () => {
  const box = { width: 400, height: 600 };

  it("keeps the scale in 1..3 and the canvas covering the box", () => {
    expect(clampViewZoom({ scale: 0.5, x: 20, y: 20 }, box)).toEqual(IDENTITY_VIEW_ZOOM);
    expect(clampViewZoom({ scale: 9, x: 50, y: 50 }, box)).toEqual({ scale: 3, x: 0, y: 0 });
    expect(clampViewZoom({ scale: 2, x: -999, y: -999 }, box)).toEqual({
      scale: 2,
      x: -400,
      y: -600,
    });
  });

  it("zooms around a point, keeping the content under it fixed", () => {
    const zoom = zoomViewAt(IDENTITY_VIEW_ZOOM, 2, { x: 200, y: 300 }, box);
    expect(zoom).toEqual({ scale: 2, x: -200, y: -300 });
    // The content point under (200, 300) is still there.
    expect((200 - zoom.x) / zoom.scale).toBe(200);
    const further = zoomViewAt(zoom, 3, { x: 100, y: 100 }, box);
    expect((100 - further.x) / further.scale).toBeCloseTo((100 - zoom.x) / zoom.scale);
  });

  it("pans within the zoomed canvas only", () => {
    const zoom = { scale: 2, x: -200, y: -300 };
    expect(panViewBy(zoom, 50, 50, box)).toEqual({ scale: 2, x: -150, y: -250 });
    expect(panViewBy(zoom, 500, 500, box)).toEqual({ scale: 2, x: 0, y: 0 });
    expect(panViewBy(zoom, -500, -500, box)).toEqual({ scale: 2, x: -400, y: -600 });
  });

  it("double tap toggles 1x and 2.5x at the tap", () => {
    const zoomed = toggleViewZoomAt(IDENTITY_VIEW_ZOOM, { x: 100, y: 150 }, box);
    expect(zoomed.scale).toBe(2.5);
    expect((100 - zoomed.x) / zoomed.scale).toBeCloseTo(100);
    expect(toggleViewZoomAt(zoomed, { x: 10, y: 10 }, box)).toEqual(IDENTITY_VIEW_ZOOM);
  });

  it("pinch scales by the finger distance and follows the centre", () => {
    const start = IDENTITY_VIEW_ZOOM;
    const pinched = pinchViewZoom(start, { x: 200, y: 300 }, 100, { x: 200, y: 300 }, 200, box);
    expect(pinched).toEqual({ scale: 2, x: -200, y: -300 });
    // Moving the centre pans while pinching.
    const panned = pinchViewZoom(start, { x: 200, y: 300 }, 100, { x: 250, y: 320 }, 200, box);
    expect(panned.scale).toBe(2);
    expect((250 - panned.x) / 2).toBeCloseTo(200);
    // Spreading past 3x stops at 3x.
    expect(pinchViewZoom(start, { x: 0, y: 0 }, 10, { x: 0, y: 0 }, 1000, box).scale).toBe(3);
  });

  it("maps a client point back through the zoom", () => {
    const rect = { left: 10, top: 20, width: 400, height: 600 };
    const zoom = { scale: 2, x: -200, y: -300 };
    // Content at the box centre of a 2x view anchored top-left is unzoomed back.
    expect(unzoomClientPoint(210, 320, rect, zoom)).toEqual({ x: 210, y: 320 });
    expect(unzoomClientPoint(10, 20, rect, zoom)).toEqual({ x: 110, y: 170 });
  });

  it("maps taps to viewport coordinates under zoom", () => {
    // 400x600 box, 1280x800 frame: drawn 400x250 at top 175.
    const rect = { left: 0, top: 0, width: 400, height: 600 };
    expect(mapZoomedClientPointToViewport(200, 300, rect, IDENTITY_VIEW_ZOOM, 1280, 800)).toEqual({
      x: 640,
      y: 400,
    });
    // At 2.5x around the box centre, the centre still maps to the page centre.
    const zoom = zoomViewAt(IDENTITY_VIEW_ZOOM, 2.5, { x: 200, y: 300 }, rect);
    expect(mapZoomedClientPointToViewport(200, 300, rect, zoom, 1280, 800)).toEqual({
      x: 640,
      y: 400,
    });
    // 100 client px right of the centre is 100/2.5 unzoomed px = 128 viewport px.
    const right = mapZoomedClientPointToViewport(300, 300, rect, zoom, 1280, 800)!;
    expect(right.x).toBeCloseTo(640 + 128);
    expect(right.y).toBeCloseTo(400);
    // The box's top-left corner shows page content (384, 16) at 2.5x.
    const corner = mapZoomedClientPointToViewport(0, 0, rect, zoom, 1280, 800)!;
    expect(corner.x).toBeCloseTo(384);
    expect(corner.y).toBeCloseTo(16);
    // A point in a bar is not a click target.
    expect(mapZoomedClientPointToViewport(200, 10, rect, IDENTITY_VIEW_ZOOM, 1280, 800)).toBeNull();
  });

  it("converts finger distance to viewport distance under zoom", () => {
    const rect = { left: 0, top: 0, width: 400, height: 600 };
    expect(viewportPerClientPx(rect, IDENTITY_VIEW_ZOOM, 1280, 800)).toBeCloseTo(3.2);
    expect(viewportPerClientPx(rect, { scale: 2, x: 0, y: 0 }, 1280, 800)).toBeCloseTo(1.6);
  });
});

describe("classifyTouchGesture", () => {
  const base = { maxTouches: 1, travel: 0, elapsedMs: 0, ended: false };

  it("is pending while a still finger is down", () => {
    expect(classifyTouchGesture(base)).toBe("pending");
    expect(classifyTouchGesture({ ...base, elapsedMs: 499 })).toBe("pending");
  });

  it("a quick lift without moving is a tap", () => {
    expect(classifyTouchGesture({ ...base, elapsedMs: 80, ended: true })).toBe("tap");
    expect(classifyTouchGesture({ ...base, travel: 10, elapsedMs: 80, ended: true })).toBe("tap");
  });

  it("moving past the slop is a drag, even when held long", () => {
    expect(classifyTouchGesture({ ...base, travel: 11 })).toBe("drag");
    expect(classifyTouchGesture({ ...base, travel: 40, elapsedMs: 900, ended: true })).toBe("drag");
  });

  it("holding still for 500 ms is a long press", () => {
    expect(classifyTouchGesture({ ...base, elapsedMs: 500 })).toBe("long-press");
    expect(classifyTouchGesture({ ...base, elapsedMs: 700, ended: true })).toBe("long-press");
  });

  it("two fingers win over everything and are never sent", () => {
    expect(classifyTouchGesture({ ...base, maxTouches: 2 })).toBe("two-finger");
    expect(
      classifyTouchGesture({ maxTouches: 2, travel: 80, elapsedMs: 900, ended: true }),
    ).toBe("two-finger");
  });

  it("detects a double tap by time and place", () => {
    const first = { time: 1000, x: 100, y: 100 };
    expect(isDoubleTap(null, first)).toBe(false);
    expect(isDoubleTap(first, { time: 1200, x: 110, y: 105 })).toBe(true);
    expect(isDoubleTap(first, { time: 1400, x: 100, y: 100 })).toBe(false);
    expect(isDoubleTap(first, { time: 1100, x: 200, y: 100 })).toBe(false);
  });
});

describe("touch input events", () => {
  it("a tap is move, left down, left up at the point", () => {
    expect(tapEvents({ x: 5, y: 6 })).toEqual([
      { kind: "mouse", action: "move", x: 5, y: 6, button: "none", buttons: 0, click_count: 0, modifiers: 0 },
      { kind: "mouse", action: "down", x: 5, y: 6, button: "left", buttons: 1, click_count: 1, modifiers: 0 },
      { kind: "mouse", action: "up", x: 5, y: 6, button: "left", buttons: 0, click_count: 1, modifiers: 0 },
    ]);
  });

  it("a long press is a right click", () => {
    const events = tapEvents({ x: 1, y: 2 }, "right");
    expect(events[1]).toMatchObject({ action: "down", button: "right", buttons: 2 });
    expect(events[2]).toMatchObject({ action: "up", button: "right", buttons: 0 });
  });

  it("a drag scrolls the page the other way, in viewport px", () => {
    // Finger up by 30 px, 3.2 viewport px per client px: page scrolls down 96.
    expect(dragWheelEvent({ x: 640, y: 400 }, 0, -30, 3.2)).toEqual({
      kind: "wheel",
      x: 640,
      y: 400,
      delta_x: -0,
      delta_y: 96,
      modifiers: 0,
    });
  });
});

describe("soft keyboard mapping", () => {
  it("commits plain and replacement text", () => {
    expect(softInputAction("insertText", "abc", false)).toEqual({ kind: "text", text: "abc" });
    expect(softInputAction("insertReplacementText", "fixed", false)).toEqual({
      kind: "text",
      text: "fixed",
    });
    expect(softInputAction("insertText", null, false)).toBeNull();
  });

  it("sends nothing while an IME composes; the commit arrives at compositionend", () => {
    expect(softInputAction("insertCompositionText", "你", true)).toBeNull();
    expect(softInputAction("insertCompositionText", "你好", false)).toBeNull();
    expect(softInputAction("insertText", "x", true)).toBeNull();
    expect(softInputAction("deleteContentBackward", null, true)).toBeNull();
    expect(compositionEndAction("你好")).toEqual({ kind: "text", text: "你好" });
    expect(compositionEndAction("")).toBeNull();
    expect(compositionEndAction(null)).toBeNull();
  });

  it("maps backspace and line breaks to keys", () => {
    expect(softInputAction("deleteContentBackward", null, false)).toEqual({
      kind: "key",
      key: "Backspace",
    });
    expect(softInputAction("insertLineBreak", null, false)).toEqual({ kind: "key", key: "Enter" });
    expect(softInputAction("insertParagraph", null, false)).toEqual({ kind: "key", key: "Enter" });
    expect(softInputAction("historyUndo", null, false)).toBeNull();
  });

  it("builds key down and up for the key row", () => {
    expect(softKeyEvents("Enter")).toEqual([
      { kind: "key", action: "down", key: "Enter", code: "Enter", modifiers: 0, key_code: 13 },
      { kind: "key", action: "up", key: "Enter", code: "Enter", modifiers: 0, key_code: 13 },
    ]);
    expect(softKeyEvents("ArrowLeft")[0]).toMatchObject({ key: "ArrowLeft", key_code: 37 });
    expect(softKeyEvents("Backspace")[1]).toMatchObject({ action: "up", key_code: 8 });
  });
});
