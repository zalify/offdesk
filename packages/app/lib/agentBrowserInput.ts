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

export type BrowserShortcut = "back" | "forward" | "reload" | "address";

/**
 * A browser shortcut the toolbar handles instead of the page, as in Chrome:
 * on a Mac Cmd+[ / Cmd+] / Cmd+R / Cmd+L, elsewhere Alt+Left / Alt+Right /
 * Ctrl+R / Ctrl+L; F5 everywhere. Option+arrows and Ctrl+L on a Mac stay with
 * the page (word jumps, a web terminal's clear screen).
 */
export function browserShortcut(
  event: KeyEventLike,
  mac: boolean,
): BrowserShortcut | null {
  const { altKey: alt, ctrlKey: ctrl, metaKey: meta, shiftKey: shift } = event;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (event.key === "F5" && !alt && !meta) return "reload";
  if (shift) return null;
  if (mac && meta && !ctrl && !alt) {
    if (key === "[" || event.code === "BracketLeft") return "back";
    if (key === "]" || event.code === "BracketRight") return "forward";
    if (key === "r") return "reload";
    if (key === "l") return "address";
    return null;
  }
  if (mac) return null;
  if (ctrl && !meta && !alt) {
    if (key === "r") return "reload";
    if (key === "l") return "address";
    return null;
  }
  if (alt && !ctrl && !meta) {
    if (key === "ArrowLeft") return "back";
    if (key === "ArrowRight") return "forward";
  }
  return null;
}

// ---- Local view zoom (phone) ----
//
// A view aid only: it scales the canvas inside its box and is never sent to
// the page. The canvas is drawn with `transform: translate(x, y) scale(scale)`
// and `transform-origin: 0 0`, with `x` / `y` in box-local CSS px.

export const VIEW_ZOOM_MIN = 1;
export const VIEW_ZOOM_MAX = 3;
/** Zoom a double tap toggles to. */
export const VIEW_ZOOM_DOUBLE_TAP = 2.5;

export interface ViewZoom {
  scale: number;
  x: number;
  y: number;
}

export const IDENTITY_VIEW_ZOOM: ViewZoom = { scale: 1, x: 0, y: 0 };

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Keep the scale in range and the zoomed canvas covering the whole box. */
export function clampViewZoom(zoom: ViewZoom, box: Size): ViewZoom {
  const scale = Math.min(VIEW_ZOOM_MAX, Math.max(VIEW_ZOOM_MIN, zoom.scale));
  if (scale === 1) return IDENTITY_VIEW_ZOOM;
  return {
    scale,
    x: Math.min(0, Math.max(box.width * (1 - scale), zoom.x)),
    y: Math.min(0, Math.max(box.height * (1 - scale), zoom.y)),
  };
}

/** Zoom to `scale` keeping the content under `point` (box-local) in place. */
export function zoomViewAt(
  zoom: ViewZoom,
  scale: number,
  point: Point,
  box: Size,
): ViewZoom {
  const next = Math.min(VIEW_ZOOM_MAX, Math.max(VIEW_ZOOM_MIN, scale));
  const contentX = (point.x - zoom.x) / zoom.scale;
  const contentY = (point.y - zoom.y) / zoom.scale;
  return clampViewZoom(
    { scale: next, x: point.x - contentX * next, y: point.y - contentY * next },
    box,
  );
}

export function panViewBy(
  zoom: ViewZoom,
  dx: number,
  dy: number,
  box: Size,
): ViewZoom {
  return clampViewZoom({ ...zoom, x: zoom.x + dx, y: zoom.y + dy }, box);
}

/** Double tap: back to 1x when zoomed, else 2.5x around the tap. */
export function toggleViewZoomAt(
  zoom: ViewZoom,
  point: Point,
  box: Size,
): ViewZoom {
  return zoom.scale > 1
    ? IDENTITY_VIEW_ZOOM
    : zoomViewAt(zoom, VIEW_ZOOM_DOUBLE_TAP, point, box);
}

/**
 * Two-finger gesture: the content point that was under the fingers' centre at
 * the start follows the centre (pan) while the scale follows the finger
 * distance (pinch). All points are box-local.
 */
export function pinchViewZoom(
  start: ViewZoom,
  startCenter: Point,
  startDistance: number,
  center: Point,
  distance: number,
  box: Size,
): ViewZoom {
  const ratio = startDistance > 0 ? distance / startDistance : 1;
  const scale = Math.min(
    VIEW_ZOOM_MAX,
    Math.max(VIEW_ZOOM_MIN, start.scale * ratio),
  );
  const contentX = (startCenter.x - start.x) / start.scale;
  const contentY = (startCenter.y - start.y) / start.scale;
  return clampViewZoom(
    { scale, x: center.x - contentX * scale, y: center.y - contentY * scale },
    box,
  );
}

/**
 * Client point mapped back through the view zoom: where the same point would
 * be with the canvas unzoomed. `boxRect` is the untransformed box.
 */
export function unzoomClientPoint(
  clientX: number,
  clientY: number,
  boxRect: Rect,
  zoom: ViewZoom,
): Point {
  return {
    x: boxRect.left + (clientX - boxRect.left - zoom.x) / zoom.scale,
    y: boxRect.top + (clientY - boxRect.top - zoom.y) / zoom.scale,
  };
}

/** `mapClientPointToViewport` for a canvas under a local view zoom. */
export function mapZoomedClientPointToViewport(
  clientX: number,
  clientY: number,
  boxRect: Rect,
  zoom: ViewZoom,
  frameWidth: number,
  frameHeight: number,
  meta?: AgentBrowserFrameMeta | null,
): Point | null {
  const point = unzoomClientPoint(clientX, clientY, boxRect, zoom);
  return mapClientPointToViewport(
    point.x,
    point.y,
    boxRect,
    frameWidth,
    frameHeight,
    meta,
  );
}

/** Viewport CSS px that one client px covers under the zoom (for drag to wheel). */
export function viewportPerClientPx(
  boxRect: Rect,
  zoom: ViewZoom,
  frameWidth: number,
  frameHeight: number,
  meta?: AgentBrowserFrameMeta | null,
): number {
  const image = containedImageRect(boxRect, frameWidth, frameHeight);
  if (!image) return 1;
  const deviceWidth = positive(meta?.deviceWidth, AGENT_BROWSER_VIEWPORT.width);
  const pageScale = positive(meta?.pageScaleFactor, 1);
  return deviceWidth / pageScale / image.width / zoom.scale;
}

// ---- Touch gestures (phone) ----

/** A touch that moves farther than this is a drag, not a tap. */
export const TOUCH_TAP_SLOP_PX = 10;
/** A touch held this long without moving is a long press. */
export const TOUCH_LONG_PRESS_MS = 500;
/** Two taps this close in time and place are a double tap. */
export const DOUBLE_TAP_MS = 300;
export const DOUBLE_TAP_SLOP_PX = 30;

export type TouchGesture =
  | "pending"
  | "tap"
  | "drag"
  | "long-press"
  | "two-finger";

/**
 * Classify a touch from what has been observed so far: the most fingers that
 * were down at once, how far the first finger travelled from where it
 * started, how long it has been down, and whether it has lifted.
 *
 * Two fingers always win (they are reserved for local zoom / pan and never
 * reach the page), then travel (drag), then time (long press), then a lift
 * is a tap.
 */
export function classifyTouchGesture(state: {
  maxTouches: number;
  travel: number;
  elapsedMs: number;
  ended: boolean;
}): TouchGesture {
  if (state.maxTouches >= 2) return "two-finger";
  if (state.travel > TOUCH_TAP_SLOP_PX) return "drag";
  if (state.elapsedMs >= TOUCH_LONG_PRESS_MS) return "long-press";
  return state.ended ? "tap" : "pending";
}

export function isDoubleTap(
  previous: { time: number; x: number; y: number } | null,
  current: { time: number; x: number; y: number },
): boolean {
  return (
    previous !== null &&
    current.time - previous.time <= DOUBLE_TAP_MS &&
    Math.hypot(current.x - previous.x, current.y - previous.y) <=
      DOUBLE_TAP_SLOP_PX
  );
}

/** A left click, or the right click of a long press, as input events. */
export function tapEvents(
  point: Point,
  button: "left" | "right" = "left",
): AgentBrowserInputEvent[] {
  const buttons = button === "left" ? 1 : 2;
  return [
    {
      kind: "mouse",
      action: "move",
      x: point.x,
      y: point.y,
      button: "none",
      buttons: 0,
      click_count: 0,
      modifiers: 0,
    },
    {
      kind: "mouse",
      action: "down",
      x: point.x,
      y: point.y,
      button,
      buttons,
      click_count: 1,
      modifiers: 0,
    },
    {
      kind: "mouse",
      action: "up",
      x: point.x,
      y: point.y,
      button,
      buttons: 0,
      click_count: 1,
      modifiers: 0,
    },
  ];
}

/** A one-finger drag as a wheel event: the page follows the finger (inverted). */
export function dragWheelEvent(
  point: Point,
  fingerDeltaX: number,
  fingerDeltaY: number,
  viewportPerPx: number,
): AgentBrowserInputEvent {
  return {
    kind: "wheel",
    x: point.x,
    y: point.y,
    delta_x: -fingerDeltaX * viewportPerPx,
    delta_y: -fingerDeltaY * viewportPerPx,
    modifiers: 0,
  };
}

// ---- Soft keyboard (phone) ----

export type SoftKeyName =
  | "Enter"
  | "Backspace"
  | "Tab"
  | "Escape"
  | "ArrowUp"
  | "ArrowDown"
  | "ArrowLeft"
  | "ArrowRight";

const SOFT_KEY_CODES: Record<SoftKeyName, number> = {
  Enter: 13,
  Backspace: 8,
  Tab: 9,
  Escape: 27,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
};

/** Key down + key up of a named key (the node fills in text for Enter). */
export function softKeyEvents(name: SoftKeyName): AgentBrowserInputEvent[] {
  const common = {
    kind: "key" as const,
    key: name,
    code: name,
    modifiers: 0,
    key_code: SOFT_KEY_CODES[name],
  };
  return [
    { ...common, action: "down" },
    { ...common, action: "up" },
  ];
}

export type SoftInputAction =
  | { kind: "text"; text: string }
  | { kind: "key"; key: "Backspace" | "Enter" };

/**
 * What a `beforeinput` on the hidden textarea means for the page. Mobile IMEs
 * mostly send keyCode 229 keydowns, so text is driven from here instead.
 * Composition text (`insertCompositionText`, and anything while composing)
 * yields nothing: the committed string arrives once, with `compositionend`
 * (see `compositionEndAction`).
 */
export function softInputAction(
  inputType: string,
  data: string | null,
  isComposing: boolean,
): SoftInputAction | null {
  if (isComposing) return null;
  switch (inputType) {
    case "insertText":
    case "insertReplacementText":
      return data ? { kind: "text", text: data } : null;
    case "deleteContentBackward":
      return { kind: "key", key: "Backspace" };
    case "insertLineBreak":
    case "insertParagraph":
      return { kind: "key", key: "Enter" };
    default:
      return null;
  }
}

/** The string an IME composition committed, sent once at `compositionend`. */
export function compositionEndAction(
  data: string | null,
): SoftInputAction | null {
  return data ? { kind: "text", text: data } : null;
}
