import type { MutableRefObject } from "react";

export interface TerminalViewRef {
  sendInput: (data: string) => void;
  /** Paste through xterm without submitting or moving focus. */
  pasteText: (text: string) => void;
  sendCommandInput: (data: string) => void;
  // skipIfUnchanged: when true, suppress the WS resize frame if the
  // computed dims already match the live terminal. Used by mobile
  // auto-fit-on-entry; manual Fit clicks omit it so they always re-send.
  fitToContainer: (opts?: { skipIfUnchanged?: boolean }) => void;
  scrollToBottom: () => void;
  focus: () => void;
  blur: () => void;
  // Upload a file picked from a system picker (or dropped) into the terminal
  // session over the chunked upload protocol; the node bracket-pastes the
  // resulting path. Falls back to the legacy single-message `image_paste` on
  // an old hub/node for files that fit. Resolves once the node has the whole
  // file (rejects with the reason otherwise); `onProgress` reports bytes the
  // node has received.
  sendImageFile: (file: Blob & { name?: string }, onProgress?: (sent: number, total: number) => void) => Promise<void>;
  // Toggle mouse-tracking mode (DECSET 1003 + 1006). Disabling lets the
  // terminal capture drag/long-press for native text selection on touch
  // devices. Re-enable to restore mouse forwarding when leaving select
  // mode. May be a no-op on backends that don't run xterm directly.
  setMouseTrackingEnabled: (enabled: boolean) => void;
  // Return the currently selected text (empty string if no selection).
  getSelection: () => string;
  // Snapshot the visible viewport as plain text + font metrics. Mobile
  // select mode renders this as a <pre> overlay so the browser's native
  // long-press selection works — xterm's canvas-rendered text isn't in
  // the DOM and so cannot be selected by touch (xterm.js issue #3727).
  // Returns null if no terminal is mounted yet.
  getSelectionSnapshot: () => SelectionSnapshot | null;
}

export interface SelectionSnapshot {
  /** Visible viewport, one entry per row. Trailing whitespace trimmed. */
  lines: string[];
  /** Font family the terminal is currently rendering with. */
  fontFamily: string;
  /** Font size in pixels. */
  fontSize: number;
}

export interface TerminalViewProps {
  machineId: string;
  terminalId: string;
  wsUrl?: string;
  cols: number;
  rows: number;
  displayMode?: "card" | "immersive";
  isController?: boolean;
  canType?: boolean;
  canResizeTerminal?: boolean;
  onTitleChange?: (title: string) => void;
  onReconnectingChange?: (reconnecting: boolean) => void;
  /**
   * Called once per mount, when the first screen is painted at the size it
   * stays at, or when the attach fails and the view shows reconnecting.
   */
  onReady?: () => void;
  /** The terminal's current working directory; relative path links resolve against it. */
  cwd?: string;
  /**
   * A tapped path link turned out to be a directory. `path` is absolute (or
   * `~`-prefixed). Without a handler the user just sees a notice.
   */
  onOpenDirectory?: (machineId: string, path: string) => void;
  // Optional outgoing-input transform (mobile Ctrl latch). Stored behind a
  // ref because the xterm onData handler is registered once at mount; the
  // ref keeps it reading the latest transform. Returns the data to send.
  inputTransformRef?: MutableRefObject<((data: string) => string) | null>;
  /** Platform-specific style object (CSSProperties on web, ViewStyle on native) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  style?: any;
}
