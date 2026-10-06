// Pure helpers that turn DOM input on an agent browser's canvas into the
// `AgentBrowserInputEvent`s the hub forwards to the node. Framework-free so
// the mobile client can reuse them.

import type { AgentBrowserInputEvent } from "@offdesk/shared";

/** The agent browser's fixed viewport, in CSS px. */
export const AGENT_BROWSER_VIEWPORT = { width: 1280, height: 800 } as const;

/** CDP modifier bitmask. */
export const MODIFIER_ALT = 1;
export const MODIFIER_CTRL = 2;
export const MODIFIER_META = 4;
export const MODIFIER_SHIFT = 8;

/** Metadata that accompanies each screencast frame (CDP `Page.screencastFrame`). */
export interface AgentBrowserFrameMeta {
  deviceWidth?: number;
  deviceHeight?: number;
  offsetTop?: number;
  pageScaleFactor?: number;
  scrollOffsetX?: number;
  scrollOffsetY?: number;
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Parse the JSON meta of a downstream frame; `null` when it is not usable. */
export function parseFrameMeta(bytes: Uint8Array): AgentBrowserFrameMeta | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return value && typeof value === "object"
      ? (value as AgentBrowserFrameMeta)
      : null;
  } catch {
    return null;
  }
}

/**
 * Where an image of `imageWidth` x `imageHeight` is drawn inside `box` with
 * `object-fit: contain`: centered, scaled to fit, letterboxed.
 */
export function containedImageRect(
  box: Rect,
  imageWidth: number,
  imageHeight: number,
): Rect | null {
  if (
    box.width <= 0 ||
    box.height <= 0 ||
    imageWidth <= 0 ||
    imageHeight <= 0
  ) {
    return null;
  }
  const scale = Math.min(box.width / imageWidth, box.height / imageHeight);
  const width = imageWidth * scale;
  const height = imageHeight * scale;
  return {
    left: box.left + (box.width - width) / 2,
    top: box.top + (box.height - height) / 2,
    width,
    height,
  };
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

/**
 * Map a client point to viewport CSS px. `canvasRect` is the canvas element's
 * box; the frame of `frameWidth` x `frameHeight` px is drawn letterboxed in
 * it. `null` outside the drawn image (the black bars).
 */
export function mapClientPointToViewport(
  clientX: number,
  clientY: number,
  canvasRect: Rect,
  frameWidth: number,
  frameHeight: number,
  meta?: AgentBrowserFrameMeta | null,
): { x: number; y: number } | null {
  const image = containedImageRect(canvasRect, frameWidth, frameHeight);
  if (!image) return null;
  const u = (clientX - image.left) / image.width;
  const v = (clientY - image.top) / image.height;
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  const scale = positive(meta?.pageScaleFactor, 1);
  const deviceWidth = positive(meta?.deviceWidth, AGENT_BROWSER_VIEWPORT.width);
  const deviceHeight = positive(
    meta?.deviceHeight,
    AGENT_BROWSER_VIEWPORT.height,
  );
  const offsetTop =
    typeof meta?.offsetTop === "number" && Number.isFinite(meta.offsetTop)
      ? Math.max(0, meta.offsetTop)
      : 0;
  const visibleHeight = Math.max(1, deviceHeight - offsetTop);
  return {
    x: Math.min(deviceWidth / scale, (u * deviceWidth) / scale),
    y: Math.min(visibleHeight / scale, (v * visibleHeight) / scale),
  };
}

export interface ModifierState {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export function modifiersOf(event: ModifierState): number {
  return (
    (event.altKey ? MODIFIER_ALT : 0) |
    (event.ctrlKey ? MODIFIER_CTRL : 0) |
    (event.metaKey ? MODIFIER_META : 0) |
    (event.shiftKey ? MODIFIER_SHIFT : 0)
  );
}

type MouseButtonName = "left" | "middle" | "right" | "none";

/** DOM `MouseEvent.button` to the protocol's button name. */
export function buttonName(button: number): MouseButtonName {
  switch (button) {
    case 0:
      return "left";
    case 1:
      return "middle";
    case 2:
      return "right";
    default:
      return "none";
  }
}

/** The DOM `buttons` bitmask is the CDP one (left 1, right 2, middle 4). */
export function mouseEvent(
  action: "move" | "down" | "up",
  point: { x: number; y: number },
  event: ModifierState & { button: number; buttons: number; detail: number },
): AgentBrowserInputEvent {
  return {
    kind: "mouse",
    action,
    x: point.x,
    y: point.y,
    button: action === "move" ? "none" : buttonName(event.button),
    buttons: event.buttons,
    click_count: action === "move" ? 0 : Math.max(1, event.detail || 1),
    modifiers: modifiersOf(event),
  };
}

/** Wheel deltas arrive in pixels; line/page modes are converted. */
export function wheelEvent(
  point: { x: number; y: number },
  event: ModifierState & { deltaX: number; deltaY: number; deltaMode: number },
): AgentBrowserInputEvent {
  const factor =
    event.deltaMode === 1
      ? 40
      : event.deltaMode === 2
        ? AGENT_BROWSER_VIEWPORT.height
        : 1;
  return {
    kind: "wheel",
    x: point.x,
    y: point.y,
    delta_x: event.deltaX * factor,
    delta_y: event.deltaY * factor,
    modifiers: modifiersOf(event),
  };
}

export interface KeyEventLike extends ModifierState {
  key: string;
  code: string;
  keyCode?: number;
  isComposing?: boolean;
}

/** True while an IME composition owns the keystrokes (no key events then). */
export function isComposingKey(event: KeyEventLike): boolean {
  return Boolean(event.isComposing) || event.keyCode === 229;
}

/** One printable character (a single code point), as typed by the user. */
function isPrintable(key: string): boolean {
  return [...key].length === 1 && key >= " " && key !== "\u007f";
}

export function keyEvent(
  action: "down" | "up",
  event: KeyEventLike,
): AgentBrowserInputEvent {
  const built: AgentBrowserInputEvent = {
    kind: "key",
    action,
    key: event.key,
    code: event.code,
    modifiers: modifiersOf(event),
  };
  if (isPrintable(event.key) && !event.ctrlKey && !event.metaKey) {
    built.text = event.key;
  }
  if (typeof event.keyCode === "number" && event.keyCode > 0) {
    built.key_code = event.keyCode;
  }
  return built;
}

export function textEvent(text: string): AgentBrowserInputEvent | null {
  return text === "" ? null : { kind: "text", text };
}
