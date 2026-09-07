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
  // Forward an image / file picked from a system picker into the terminal
  // session via the existing `image_paste` WS protocol. Returns once the
  // frame has been queued (or rejects with the reason it was skipped).
  sendImageFile: (file: Blob & { name?: string }) => Promise<void>;
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
  // Optional outgoing-input transform (mobile Ctrl latch). Stored behind a
  // ref because the xterm onData handler is registered once at mount; the
  // ref keeps it reading the latest transform. Returns the data to send.
  inputTransformRef?: MutableRefObject<((data: string) => string) | null>;
  /** Platform-specific style object (CSSProperties on web, ViewStyle on native) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  style?: any;
}
