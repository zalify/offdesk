import { describe, expect, it } from "vitest";
import {
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
