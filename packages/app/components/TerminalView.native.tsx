import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { openSocket } from "@/lib/secureTransport";
import { createDeflateRawV1Session } from "@/lib/attachCompression";
import { createTerminalReconnectController } from "@/lib/terminalReconnect";
import { DEFAULT_TERMINAL_FONT, TERMINAL_SYMBOL_FONT } from "@/lib/terminalFonts";
import { readTerminalFontPreferences, subscribeFontPreferences } from "@/lib/fontPreferences";
import { useTerminalTheme } from "@/lib/theme";
import {
  buildImagePasteMessage,
  MAX_IMAGE_PASTE_BYTES,
  readFileAsBase64,
  safeFilename,
  waitForWsOpen,
} from "@/lib/terminalImagePaste";
import { UploadError, uploadFallsBackToLegacy, uploadFileChunked } from "@/lib/terminalUpload";
import { createExternalUrlOpener } from "@/lib/terminalLinks";
import { readClipboardText } from "@/lib/readClipboardText";
import {
  createSelection,
  extractSelectionText,
  getVisibleSelectionRanges,
  isWideChar,
  syncSelectionWithFrame,
  updateSelectionEnd,
  type NativeSelectionState,
} from "@/lib/nativeTermSelection";
import type { SelectionSnapshot, TerminalViewProps, TerminalViewRef } from "./TerminalView.types";

const openExternalUrl = createExternalUrlOpener({
  isTauri: () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window,
  tauriOpenUrl: (url) => invoke("plugin:opener|open_url", { url }),
  tauriShellOpen: (url) => invoke("plugin:shell|open", { path: url }),
  windowOpen: (url) => {
    window.open(url, "_blank", "noopener,noreferrer");
  },
});

function resolveRemotePath(raw: string, cwd?: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("/") || trimmed.startsWith("~")) return trimmed;
  if (!cwd) return trimmed;
  const base = cwd.replace(/\/+$/, "");
  return `${base}/${trimmed.replace(/^\.\//, "")}`;
}

interface NativeSpan {
  c: number;
  t: string;
  f?: string;
  b?: boolean;
  i?: boolean;
  u?: boolean;
  s?: boolean;
  h?: string;
}

interface NativeBgRun {
  r: number;
  c: number;
  l: number;
  g: string;
}

const DAEMON_SNAP_PREFIX_LEGACY = new TextEncoder().encode("\x1b[?2026h\x1b[0m\x1b[r");
const DAEMON_SNAP_PREFIX_ALT = new TextEncoder().encode("\x1b[?2026h\x1b[?1049");

function bytesContainPrefix(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0 || haystack.length < needle.length) return false;
  const limit = Math.min(haystack.length - needle.length, 64);
  for (let i = 0; i <= limit; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

function hasDaemonSnapshotHeader(bytes: Uint8Array): boolean {
  return (
    bytesContainPrefix(bytes, DAEMON_SNAP_PREFIX_LEGACY) ||
    bytesContainPrefix(bytes, DAEMON_SNAP_PREFIX_ALT)
  );
}

interface NativeTermFrame {
  cols: number;
  rows: number;
  spans: NativeSpan[][];
  bgs: NativeBgRun[];
  cursor: [number, number] | null;
  cursor_shape?: "block" | "beam" | "underline" | "hollow";
  display_offset: number;
  history_size?: number;
  wants_mouse: boolean;
  bracketed_paste: boolean;
  app_cursor?: boolean;
  title?: string;
  clipboard_write?: string;
  wrapped_rows?: boolean[];
}

/**
 * Ghostty-style pixel-exact geometric rendering for Unicode Box Drawing &
 * Block Elements (U+2500..U+259F). Returns true if drawn geometrically so
 * font-metric line-height gaps never split borders or dividers.
 */
function drawBoxChar(
  ctx: CanvasRenderingContext2D,
  cp: number,
  x: number,
  y: number,
  w: number,
  h: number,
): boolean {
  if (cp < 0x2500 || cp > 0x259f) return false;
  const rx = Math.floor(x);
  const ry = Math.floor(y);
  const rw = Math.ceil(x + w) - rx;
  const rh = Math.ceil(y + h) - ry;
  const cx = rx + Math.floor(rw / 2);
  const cy = ry + Math.floor(rh / 2);
  const t = Math.max(1, Math.round(w / 8));
  const heavy = Math.max(2, t * 2);

  switch (cp) {
    // Horizontal & vertical lines
    case 0x2500: // ─
      ctx.fillRect(rx, cy, rw, t);
      return true;
    case 0x2501: // ━
      ctx.fillRect(rx, cy - Math.floor((heavy - t) / 2), rw, heavy);
      return true;
    case 0x2502: // │
      ctx.fillRect(cx, ry, t, rh);
      return true;
    case 0x2503: // ┃
      ctx.fillRect(cx - Math.floor((heavy - t) / 2), ry, heavy, rh);
      return true;
    // Double lines
    case 0x2550: // ═
      ctx.fillRect(rx, cy - t, rw, t);
      ctx.fillRect(rx, cy + t, rw, t);
      return true;
    case 0x2551: // ║
      ctx.fillRect(cx - t, ry, t, rh);
      ctx.fillRect(cx + t, ry, t, rh);
      return true;
    // Corners (light & rounded)
    case 0x250c: // ┌
    case 0x256d: // ╭
      ctx.fillRect(cx, cy, rx + rw - cx, t);
      ctx.fillRect(cx, cy, t, ry + rh - cy);
      return true;
    case 0x2510: // ┐
    case 0x256e: // ╮
      ctx.fillRect(rx, cy, cx - rx + t, t);
      ctx.fillRect(cx, cy, t, ry + rh - cy);
      return true;
    case 0x2514: // └
    case 0x2570: // ╰
      ctx.fillRect(cx, cy, rx + rw - cx, t);
      ctx.fillRect(cx, ry, t, cy - ry + t);
      return true;
    case 0x2518: // ┘
    case 0x256f: // ╯
      ctx.fillRect(rx, cy, cx - rx + t, t);
      ctx.fillRect(cx, ry, t, cy - ry + t);
      return true;
    // Tees & cross
    case 0x251c: // ├
      ctx.fillRect(cx, ry, t, rh);
      ctx.fillRect(cx, cy, rx + rw - cx, t);
      return true;
    case 0x2524: // ┤
      ctx.fillRect(cx, ry, t, rh);
      ctx.fillRect(rx, cy, cx - rx + t, t);
      return true;
    case 0x252c: // ┬
      ctx.fillRect(rx, cy, rw, t);
      ctx.fillRect(cx, cy, t, ry + rh - cy);
      return true;
    case 0x2534: // ┴
      ctx.fillRect(rx, cy, rw, t);
      ctx.fillRect(cx, ry, t, cy - ry + t);
      return true;
    case 0x253c: // ┼
      ctx.fillRect(rx, cy, rw, t);
      ctx.fillRect(cx, ry, t, rh);
      return true;
    // Block elements
    case 0x2580: // ▀
      ctx.fillRect(rx, ry, rw, Math.ceil(rh / 2));
      return true;
    case 0x2584: // ▄
      ctx.fillRect(rx, ry + Math.floor(rh / 2), rw, Math.ceil(rh / 2));
      return true;
    case 0x2588: // █
      ctx.fillRect(rx, ry, rw, rh);
      return true;
    case 0x258c: // ▌
      ctx.fillRect(rx, ry, Math.ceil(rw / 2), rh);
      return true;
    case 0x2590: // ▐
      ctx.fillRect(rx + Math.floor(rw / 2), ry, Math.ceil(rw / 2), rh);
      return true;
    case 0x2591: // ░
    case 0x2592: // ▒
    case 0x2593: { // ▓
      const prevAlpha = ctx.globalAlpha;
      ctx.globalAlpha = cp === 0x2591 ? 0.25 : cp === 0x2592 ? 0.5 : 0.75;
      ctx.fillRect(rx, ry, rw, rh);
      ctx.globalAlpha = prevAlpha;
      return true;
    }
    default:
      return false;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function keyEventToBytes(
  e: React.KeyboardEvent<HTMLTextAreaElement>,
  appCursor = false,
): string | null {
  if (e.nativeEvent.isComposing || e.key === "Process") return null;

  // macOS native terminal line-editing shortcuts (Cmd+Backspace, Cmd+Left/Right)
  if (e.metaKey && !e.ctrlKey && !e.altKey) {
    if (e.key === "Backspace") return "\x15"; // Ctrl+U: kill to start of line
    if (e.key === "ArrowLeft") return "\x01"; // Ctrl+A: beginning of line
    if (e.key === "ArrowRight") return "\x05"; // Ctrl+E: end of line
    return null; // let macOS Cmd+C/V/F/K/W work
  }

  if (e.ctrlKey && !e.altKey && e.key.length === 1) {
    const code = e.key.toUpperCase().charCodeAt(0);
    if (code >= 64 && code <= 95) {
      return String.fromCharCode(code - 64);
    }
  }

  const csiMod =
    1 + (e.shiftKey ? 1 : 0) + (e.altKey ? 2 : 0) + (e.ctrlKey ? 4 : 0);

  switch (e.key) {
    case "Enter":
      // Shift+Enter inserts a newline in Claude Code / agy / fish / zsh without submitting.
      return e.shiftKey ? "\x1b\r" : "\r";
    case "Backspace":
      return e.altKey ? "\x1b\x7f" : "\x7f";
    case "Tab":
      return e.shiftKey ? "\x1b[Z" : "\t";
    case "Escape":
      return "\x1b";
    case "ArrowUp":
      if (csiMod > 1) return `\x1b[1;${csiMod}A`;
      return appCursor ? "\x1bOA" : "\x1b[A";
    case "ArrowDown":
      if (csiMod > 1) return `\x1b[1;${csiMod}B`;
      return appCursor ? "\x1bOB" : "\x1b[B";
    case "ArrowRight":
      if (e.altKey && !e.ctrlKey && !e.shiftKey) return "\x1bf"; // macOS word-right
      if (csiMod > 1) return `\x1b[1;${csiMod}C`;
      return appCursor ? "\x1bOC" : "\x1b[C";
    case "ArrowLeft":
      if (e.altKey && !e.ctrlKey && !e.shiftKey) return "\x1bb"; // macOS word-left
      if (csiMod > 1) return `\x1b[1;${csiMod}D`;
      return appCursor ? "\x1bOD" : "\x1b[D";
    case "Home":
      if (csiMod > 1) return `\x1b[1;${csiMod}H`;
      return appCursor ? "\x1bOH" : "\x1b[H";
    case "End":
      if (csiMod > 1) return `\x1b[1;${csiMod}F`;
      return appCursor ? "\x1bOF" : "\x1b[F";
    case "PageUp":
      return csiMod > 1 ? `\x1b[5;${csiMod}~` : "\x1b[5~";
    case "PageDown":
      return csiMod > 1 ? `\x1b[6;${csiMod}~` : "\x1b[6~";
    case "Delete":
      return csiMod > 1 ? `\x1b[3;${csiMod}~` : "\x1b[3~";
    case "Insert":
      return csiMod > 1 ? `\x1b[2;${csiMod}~` : "\x1b[2~";
    case "F1":
      return "\x1bOP";
    case "F2":
      return "\x1bOQ";
    case "F3":
      return "\x1bOR";
    case "F4":
      return "\x1bOS";
    case "F5":
      return "\x1b[15~";
    case "F6":
      return "\x1b[17~";
    case "F7":
      return "\x1b[18~";
    case "F8":
      return "\x1b[19~";
    case "F9":
      return "\x1b[20~";
    case "F10":
      return "\x1b[21~";
    case "F11":
      return "\x1b[23~";
    case "F12":
      return "\x1b[24~";
    default:
      if (e.altKey && e.key.length === 1) {
        return `\x1b${e.key}`;
      }
      return null;
  }
}

// DEC Mode 2026 Synchronized Output markers:
// BSU: ESC [ ? 2 0 2 6 h   |   ESU: ESC [ ? 2 0 2 6 l
const SYNC_MARKER_PREFIX = [0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x32, 0x36] as const;

function scanSyncUpdateMarkers(
  tail: Uint8Array,
  chunk: Uint8Array,
  inSync: boolean,
): { inSync: boolean; nextTail: Uint8Array } {
  const combined = tail.length > 0 ? concatChunks([tail, chunk]) : chunk;
  let state = inSync;
  const limit = combined.length - 8;
  for (let i = 0; i <= limit; i++) {
    if (
      combined[i] === SYNC_MARKER_PREFIX[0] &&
      combined[i + 1] === SYNC_MARKER_PREFIX[1] &&
      combined[i + 2] === SYNC_MARKER_PREFIX[2] &&
      combined[i + 3] === SYNC_MARKER_PREFIX[3] &&
      combined[i + 4] === SYNC_MARKER_PREFIX[4] &&
      combined[i + 5] === SYNC_MARKER_PREFIX[5] &&
      combined[i + 6] === SYNC_MARKER_PREFIX[6]
    ) {
      const code = combined[i + 7];
      if (code === 0x68 /* 'h' */) {
        state = true;
        i += 7;
      } else if (code === 0x6c /* 'l' */) {
        state = false;
        i += 7;
      }
    }
  }
  const keep = Math.min(7, combined.length);
  const nextTail = keep > 0 ? combined.slice(combined.length - keep) : new Uint8Array(0);
  return { inSync: state, nextTail };
}

// Keep the last non-empty frame per terminal in memory so remounting a pane
// paints its previous screen synchronously at 0ms while the WebSocket reconnects.
const LAST_FRAME_CACHE_LIMIT = 64;
const lastFrameCache = new Map<string, NativeTermFrame>();

function frameHasContent(frame: NativeTermFrame | null | undefined): boolean {
  if (!frame) return false;
  for (const row of frame.spans) {
    if (row.length > 0) return true;
  }
  return false;
}

function rememberFrame(terminalId: string, frame: NativeTermFrame) {
  if (!frameHasContent(frame)) return;
  if (lastFrameCache.has(terminalId)) {
    lastFrameCache.delete(terminalId);
  } else if (lastFrameCache.size >= LAST_FRAME_CACHE_LIMIT) {
    const oldest = lastFrameCache.keys().next().value;
    if (oldest !== undefined) lastFrameCache.delete(oldest);
  }
  lastFrameCache.set(terminalId, frame);
}

/**
 * Zero-xterm.js terminal view backed by Rust `alacritty_terminal 0.25` (10,000-line scrollback)
 * over Tauri IPC, painted directly onto a Retina HiDPI hardware-accelerated Canvas.
 * Runs seamlessly inside the existing Tauri Desktop/Mobile UI with zero z-index or WebGL limits.
 */
export const TerminalView = forwardRef<TerminalViewRef, TerminalViewProps>(
  function NativeTerminalView(props, ref) {
    const {
      terminalId,
      machineId,
      cwd,
      wsUrl,
      cols: initialCols,
      rows: initialRows,
      canType = true,
      canResizeTerminal = true,
      onTitleChange,
      onReconnectingChange,
      onReady,
      onOpenDirectory,
      inputTransformRef,
      style,
    } = props;

    const { theme } = useTerminalTheme();
    const containerRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const wsRef = useRef<WebSocket | null>(null);
    const frameRef = useRef<NativeTermFrame | null>(lastFrameCache.get(terminalId) ?? null);
    const hasLiveDataRef = useRef(false);
    const ptyDimsRef = useRef<{ cols: number; rows: number }>({
      cols: Math.max(20, initialCols || 80),
      rows: Math.max(6, initialRows || 24),
    });
    const dimsRef = useRef<{ cols: number; rows: number }>({
      cols: Math.max(20, initialCols || 80),
      rows: Math.max(6, initialRows || 24),
    });
    const lastSentResizeRef = useRef<{ cols: number; rows: number } | null>(null);
    const resizeConfirmTimerRef = useRef<number | null>(null);
    const resizeDebounceTimerRef = useRef<number | null>(null);
    const resizeHudTimerRef = useRef<number | null>(null);
    const hasInitialFitRef = useRef(false);
    const [resizeHud, setResizeHud] = useState<{ cols: number; rows: number; visible: boolean }>({
      cols: Math.max(20, initialCols || 80),
      rows: Math.max(6, initialRows || 24),
      visible: false,
    });
    const containerSizeRef = useRef<{ width: number; height: number }>({ width: 0, height: 0 });
    const taStyleCacheRef = useRef<{
      left: number;
      top: number;
      height: number;
      fontSize: number;
      lineHeight: number;
    } | null>(null);
    const lastHoverCellRef = useRef<{ col: number; row: number } | null>(null);
    const measureCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const metricsRef = useRef<{ cellW: number; cellH: number }>({ cellW: 8.4, cellH: 18 });
    const readyFiredRef = useRef(false);
    const composingRef = useRef(false);
    const compositionTextRef = useRef("");
    const pendingCommitTextRef = useRef("");
    const pendingCommitTimerRef = useRef<number | null>(null);
    const compositionEndAtRef = useRef(0);
    const pendingInputRef = useRef("");
    const [sessionGen, setSessionGen] = useState(0);
    const [fontPrefs, setFontPrefs] = useState(() => readTerminalFontPreferences());
    const [scrollbackOffset, setScrollbackOffset] = useState(0);
    const [historySize, setHistorySize] = useState(0);
    const committedScrollbackOffsetRef = useRef(0);
    const committedHistorySizeRef = useRef(0);
    const scrollbarShownRef = useRef(false);
    const [scrollbarVisible, setScrollbarVisible] = useState(false);
    const [scrollbarHover, setScrollbarHover] = useState(false);
    const maxObservedOffsetRef = useRef(0);
    const scrollbarFadeTimerRef = useRef<number | null>(null);
    const scrollbarTrackRef = useRef<HTMLDivElement | null>(null);
    const scrollbarDragRef = useRef(false);
    const wheelAccumPxRef = useRef(0);
    const remoteWheelActiveRef = useRef(false);
    const daemonBackedRef = useRef(false);
    const touchScrollRef = useRef<{ lastY: number; accumPx: number; clientX: number; clientY: number } | null>(null);
    const paintOffsetYRef = useRef(0);
    const pendingScrollLinesRef = useRef(0);
    const scrollInFlightRef = useRef(false);
    const scrollRafRef = useRef<number | null>(null);
    const paintRafRef = useRef<number | null>(null);
    const lastScrollBadgeUpdateRef = useRef(0);
    const termOpChainRef = useRef<Promise<void>>(Promise.resolve());
    const enqueueTermOp = useCallback(<T,>(op: () => Promise<T>): Promise<T> => {
      const next = termOpChainRef.current.then(op, op);
      termOpChainRef.current = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    }, []);
    const controlListenersRef = useRef(new Set<(text: string) => void>());
    const subscribeControl = useCallback((listener: (text: string) => void) => {
      controlListenersRef.current.add(listener);
      return () => {
        controlListenersRef.current.delete(listener);
      };
    }, []);
    const [uploadStatus, setUploadStatus] = useState<{
      text: string;
      sent?: number;
      total?: number;
      error?: boolean;
    } | null>(null);
    const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
    const [searchOpen, setSearchOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState("");
    const searchOpenRef = useRef(false);
    const searchQueryRef = useRef("");
    searchOpenRef.current = searchOpen;
    searchQueryRef.current = searchQuery;
    const [searchMatches, setSearchMatches] = useState<number[]>([]);
    const [searchIndex, setSearchIndex] = useState(0);
    const [searchLinesGen, setSearchLinesGen] = useState(0);
    const activeSearchLineRef = useRef<number | null>(null);
    const searchInputRef = useRef<HTMLInputElement | null>(null);
    const plainLinesRef = useRef<string[]>([]);
    useEffect(() => {
      if (!uploadStatus || uploadStatus.total !== undefined) return;
      const t = window.setTimeout(() => setUploadStatus(null), uploadStatus.error ? 6000 : 2500);
      return () => window.clearTimeout(t);
    }, [uploadStatus]);
    const uploadLockRef = useRef(false);
    const callbacksRef = useRef({
      onReady,
      onTitleChange,
      onReconnectingChange,
      canResizeTerminal,
    });
    callbacksRef.current = {
      onReady,
      onTitleChange,
      onReconnectingChange,
      canResizeTerminal,
    };

    // Selection state (content-anchored logical document coordinates + stitched line buffer)
    const selectionRef = useRef<NativeSelectionState | null>(null);
    const draggingRef = useRef(false);
    const lastPointerRef = useRef<{ clientX: number; clientY: number } | null>(null);
    const lastRemoteScrollDirRef = useRef<-1 | 0 | 1>(0);
    const edgeAutoScrollTimerRef = useRef<number | null>(null);
    const pointerToSelectionCellRef = useRef<(clientX: number, clientY: number) => { col: number; row: number }>(
      () => ({ col: 0, row: 0 }),
    );
    const scrollByLinesRef = useRef<(lines: number, clientX: number, clientY: number) => void>(
      () => {},
    );
    const stopEdgeAutoScroll = useCallback(() => {
      if (edgeAutoScrollTimerRef.current !== null) {
        window.clearInterval(edgeAutoScrollTimerRef.current);
        edgeAutoScrollTimerRef.current = null;
      }
    }, []);
    const focusedRef = useRef(false);
    const hoverLinkRef = useRef<{ row: number; startCol: number; endCol: number } | null>(null);
    const [hoverPointer, setHoverPointer] = useState(false);

    useEffect(() => subscribeFontPreferences(() => setFontPrefs(readTerminalFontPreferences())), []);

    const fontFamily = fontPrefs.fontFamily;
    const fontSize = fontPrefs.fontSize || 14;
    const lineHeight = Math.round(fontSize * 1.32);

    const measureCellMetrics = useCallback(() => {
      if (typeof document === "undefined") {
        return { cellW: fontSize * 0.6, cellH: lineHeight };
      }
      if (!measureCanvasRef.current) {
        measureCanvasRef.current = document.createElement("canvas");
      }
      const ctx = measureCanvasRef.current.getContext("2d");
      if (!ctx) {
        return { cellW: fontSize * 0.6, cellH: lineHeight };
      }
      ctx.font = `${fontSize}px ${fontFamily}`;
      const mw =
        Math.max(
          ctx.measureText("MMMMMMMMMM").width,
          ctx.measureText("0123456789").width,
        ) / 10;
      const cellW = mw > 4 ? mw : fontSize * 0.6;
      const cellH = lineHeight;
      metricsRef.current = { cellW, cellH };
      return { cellW, cellH };
    }, [fontSize, fontFamily, lineHeight]);

    const paintFrame = useCallback(
      (frame: NativeTermFrame | null) => {
        const canvas = canvasRef.current;
        const container = containerRef.current;
        if (!canvas || !container) return;
        let { width: rectW, height: rectH } = containerSizeRef.current;
        if (rectW < 10 || rectH < 10) {
          const rect = container.getBoundingClientRect();
          rectW = rect.width;
          rectH = rect.height;
          if (rectW >= 10 && rectH >= 10) {
            containerSizeRef.current = { width: rectW, height: rectH };
          }
        }
        if (rectW < 10 || rectH < 10) return;

        const dpr = window.devicePixelRatio || 1;
        const targetW = Math.round(rectW * dpr);
        const targetH = Math.round(rectH * dpr);
        if (canvas.width !== targetW || canvas.height !== targetH) {
          canvas.width = targetW;
          canvas.height = targetH;
        }

        const ctx = canvas.getContext("2d", { alpha: false });
        if (!ctx) return;
        ctx.save();
        ctx.scale(dpr, dpr);

        const bg = theme.background ?? "#131415";
        const fg = theme.foreground ?? "#e4e4e7";
        const cursorCol = theme.cursor ?? "#d9c773";

        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, rectW, rectH);

        const padX = 8;
        const padY = 6;
        const { cellW, cellH } = metricsRef.current;

        if (!frame) {
          paintOffsetYRef.current = 0;
          ctx.restore();
          return;
        }

        // When the container is shorter than the remote PTY grid (e.g. mobile soft
        // keyboard open while watching a desktop terminal), keep the active bottom
        // content & cursor anchored inside the visible viewport instead of clipping.
        let yOffset = 0;
        const availH = rectH - padY * 2;
        if (frame.display_offset === 0 && availH > cellH) {
          let lastContentRow = frame.cursor ? frame.cursor[1] : 0;
          for (let r = frame.spans.length - 1; r > lastContentRow; r--) {
            if (frame.spans[r] && frame.spans[r].length > 0) {
              lastContentRow = r;
              break;
            }
          }
          const contentBottom = (lastContentRow + 1) * cellH;
          if (contentBottom > availH) {
            yOffset = Math.min(0, availH - contentBottom);
          }
        }
        paintOffsetYRef.current = yOffset;
        if (yOffset !== 0) {
          ctx.translate(0, yOffset);
        }

        // 1. Background runs
        for (const run of frame.bgs) {
          ctx.fillStyle = run.g;
          ctx.fillRect(
            padX + run.c * cellW,
            padY + run.r * cellH,
            run.l * cellW + 0.5,
            cellH + 0.5,
          );
        }

        // 2. Selection highlight (content-anchored; supports stream & Option+Drag rectangular block)
        const sel = selectionRef.current;
        if (sel) {
          ctx.fillStyle = "rgba(96, 165, 250, 0.32)";
          for (const seg of getVisibleSelectionRanges(sel, frame.cols, frame.rows)) {
            ctx.fillRect(
              padX + seg.startCol * cellW,
              padY + seg.row * cellH,
              (seg.endCol - seg.startCol) * cellW,
              cellH,
            );
          }
        }

        // 3. Cursor (dynamic DECSCUSR shape + unfocused hollow outline + IME anchor)
        let solidBlockCursor: { col: number; row: number } | null = null;
        if (frame.cursor) {
          const [cx, cy] = frame.cursor;
          const cursorX = padX + cx * cellW;
          const cursorY = padY + cy * cellH;
          const shape = !focusedRef.current ? "hollow" : (frame.cursor_shape ?? "block");
          ctx.fillStyle = cursorCol;
          ctx.strokeStyle = cursorCol;
          if (shape === "beam") {
            ctx.globalAlpha = 0.92;
            ctx.fillRect(Math.round(cursorX), cursorY, 2, cellH);
          } else if (shape === "underline") {
            ctx.globalAlpha = 0.92;
            ctx.fillRect(cursorX, cursorY + cellH - 2, cellW, 2);
          } else if (shape === "hollow") {
            ctx.globalAlpha = 0.7;
            ctx.lineWidth = 1.25;
            ctx.strokeRect(cursorX + 0.75, cursorY + 0.75, cellW - 1.5, cellH - 1.5);
          } else {
            ctx.globalAlpha = 0.92;
            ctx.fillRect(cursorX, cursorY, cellW, cellH);
            solidBlockCursor = { col: cx, row: cy };
          }
          ctx.globalAlpha = 1;
          const ta = inputRef.current;
          if (ta) {
            const nextLeft = Math.round(cursorX);
            const nextTop = Math.round(cursorY + yOffset);
            const nextHeight = Math.round(cellH);
            const prevTa = taStyleCacheRef.current;
            if (
              !prevTa ||
              prevTa.left !== nextLeft ||
              prevTa.top !== nextTop ||
              prevTa.height !== nextHeight ||
              prevTa.fontSize !== fontSize ||
              prevTa.lineHeight !== cellH
            ) {
              taStyleCacheRef.current = {
                left: nextLeft,
                top: nextTop,
                height: nextHeight,
                fontSize,
                lineHeight: cellH,
              };
              ta.style.left = `${nextLeft}px`;
              ta.style.top = `${nextTop}px`;
              ta.style.height = `${nextHeight}px`;
              ta.style.fontSize = `${fontSize}px`;
              ta.style.lineHeight = `${cellH}px`;
            }
          }
        }

        // 3b. Search match highlights (Cmd+F) — bright orange on active match, soft amber on others
        const activeQuery = searchOpenRef.current ? searchQueryRef.current.trim().toLowerCase() : "";
        if (activeQuery) {
          const totalPlain = plainLinesRef.current.length;
          const activeLine = activeSearchLineRef.current;
          const activeVisRow =
            activeLine !== null && totalPlain > 0
              ? activeLine - (totalPlain - frame.rows - frame.display_offset)
              : -1;
          for (let r = 0; r < frame.spans.length; r++) {
            const rowChars = new Array<string>(frame.cols).fill(" ");
            for (const sp of frame.spans[r]) {
              let col = sp.c;
              for (const ch of sp.t) {
                const cp = ch.codePointAt(0) ?? 0;
                const w = isWideChar(cp) ? 2 : 1;
                if (col < frame.cols) rowChars[col] = ch;
                if (w === 2 && col + 1 < frame.cols) rowChars[col + 1] = "";
                col += w;
              }
            }
            const lower = rowChars.join("").toLowerCase();
            let pos = 0;
            while ((pos = lower.indexOf(activeQuery, pos)) !== -1) {
              let colStart = 0;
              let seen = 0;
              for (let c = 0; c < rowChars.length && seen < pos; c++) {
                seen += rowChars[c].length;
                colStart = c + 1;
              }
              const isActiveRow = r === activeVisRow;
              const mx = padX + colStart * cellW;
              const my = padY + r * cellH;
              const mw = activeQuery.length * cellW;
              ctx.fillStyle = isActiveRow
                ? "rgba(251, 146, 60, 0.72)"
                : "rgba(250, 204, 21, 0.28)";
              ctx.fillRect(mx, my, mw, cellH);
              if (isActiveRow) {
                ctx.strokeStyle = "#fb923c";
                ctx.lineWidth = 1.5;
                ctx.strokeRect(mx + 0.5, my + 0.5, mw - 1, cellH - 1);
              }
              pos += activeQuery.length;
            }
          }
        }

        // 4. Text spans (cached font/fill, geometric box-drawing, CJK grid align, underline/strikeout)
        ctx.textBaseline = "top";
        let lastFont = `${fontSize}px ${fontFamily}`;
        ctx.font = lastFont;
        let lastFill = "";
        for (let r = 0; r < frame.spans.length; r++) {
          const spans = frame.spans[r];
          const rowY = padY + r * cellH;
          const y = rowY + Math.floor((cellH - fontSize) * 0.5);
          const cursorOnRow = solidBlockCursor && solidBlockCursor.row === r ? solidBlockCursor.col : -1;
          for (const sp of spans) {
            const nextFont =
              sp.i || sp.b
                ? `${sp.i ? "italic " : ""}${sp.b ? "700 " : ""}${fontSize}px ${fontFamily}`
                : `${fontSize}px ${fontFamily}`;
            if (nextFont !== lastFont) {
              ctx.font = nextFont;
              lastFont = nextFont;
            }
            const nextFill = sp.f ?? fg;
            if (nextFill !== lastFill) {
              ctx.fillStyle = nextFill;
              lastFill = nextFill;
            }
            let spanCols = 0;
            if (/^[\x20-\x7e]*$/.test(sp.t)) {
              const cursorIdx = cursorOnRow - sp.c;
              if (cursorOnRow >= 0 && cursorIdx >= 0 && cursorIdx < sp.t.length) {
                if (cursorIdx > 0) {
                  ctx.fillText(sp.t.slice(0, cursorIdx), padX + sp.c * cellW, y);
                }
                if (lastFill !== bg) {
                  ctx.fillStyle = bg;
                  lastFill = bg;
                }
                ctx.fillText(sp.t[cursorIdx], padX + (sp.c + cursorIdx) * cellW, y);
                if (lastFill !== nextFill) {
                  ctx.fillStyle = nextFill;
                  lastFill = nextFill;
                }
                if (cursorIdx + 1 < sp.t.length) {
                  ctx.fillText(
                    sp.t.slice(cursorIdx + 1),
                    padX + (sp.c + cursorIdx + 1) * cellW,
                    y,
                  );
                }
              } else {
                ctx.fillText(sp.t, padX + sp.c * cellW, y);
              }
              spanCols = sp.t.length;
            } else {
              let col = sp.c;
              for (const ch of sp.t) {
                const cp = ch.codePointAt(0) ?? 0;
                const w = isWideChar(cp) ? 2 : 1;
                const isCursorCell = cursorOnRow >= col && cursorOnRow < col + w;
                if (isCursorCell && lastFill !== bg) {
                  ctx.fillStyle = bg;
                  lastFill = bg;
                } else if (!isCursorCell && lastFill !== nextFill) {
                  ctx.fillStyle = nextFill;
                  lastFill = nextFill;
                }
                if (!drawBoxChar(ctx, cp, padX + col * cellW, rowY, cellW * w, cellH)) {
                  ctx.fillText(ch, padX + col * cellW, y);
                }
                col += w;
              }
              spanCols = col - sp.c;
            }
            if (sp.u && spanCols > 0) {
              ctx.fillRect(padX + sp.c * cellW, rowY + cellH - 2, spanCols * cellW, 1);
            }
            if (sp.s && spanCols > 0) {
              ctx.fillRect(
                padX + sp.c * cellW,
                rowY + Math.floor(cellH * 0.5),
                spanCols * cellW,
                1,
              );
            }
          }
        }

        // 5. Cmd/Ctrl-hover link underline highlight
        const hl = hoverLinkRef.current;
        if (hl && hl.endCol > hl.startCol) {
          ctx.fillStyle = "rgba(96, 165, 250, 0.9)";
          ctx.fillRect(
            padX + hl.startCol * cellW,
            padY + hl.row * cellH + cellH - 2,
            (hl.endCol - hl.startCol) * cellW,
            1.5,
          );
        }

        // 6. Live IME composition preedit overlay (e.g. Pinyin "weism" before candidate commit)
        //    plus brief pending-commit hold so committed CJK text doesn't flash blank during RTT.
        const activePreedit = compositionTextRef.current;
        const preedit = activePreedit || pendingCommitTextRef.current;
        if (preedit && frame.cursor) {
          const [cx, cy] = frame.cursor;
          ctx.font = `${fontSize}px ${fontFamily}`;
          const measuredW = Math.max(cellW, Math.ceil(ctx.measureText(preedit).width) + 4);
          const preX = Math.min(
            padX + cx * cellW,
            Math.max(padX, rectW - padX - measuredW),
          );
          const preY = padY + cy * cellH;
          const textY = preY + Math.floor((cellH - fontSize) * 0.5);
          ctx.fillStyle = bg;
          ctx.fillRect(preX - 1, preY, measuredW + 2, cellH);
          if (activePreedit) {
            ctx.fillStyle = "rgba(255, 255, 255, 0.12)";
            ctx.fillRect(preX - 1, preY, measuredW + 2, cellH);
          }
          ctx.fillStyle = fg;
          ctx.textBaseline = "top";
          ctx.fillText(preedit, preX + 1, textY);
          // Underline preedit text (standard macOS / Ghostty / Alacritty IME indicator)
          if (activePreedit) {
            ctx.fillStyle = cursorCol;
            ctx.fillRect(preX, preY + cellH - 2, measuredW, 1.5);
          }
        }

        ctx.restore();
      },
      [theme, fontSize, fontFamily, lineHeight],
    );

    const schedulePaint = useCallback(() => {
      if (paintRafRef.current !== null) return;
      paintRafRef.current = window.requestAnimationFrame(() => {
        paintRafRef.current = null;
        paintFrame(frameRef.current);
      });
    }, [paintFrame]);

    const syncVisibleHistorySize = useCallback(() => {
      const frame = frameRef.current;
      if (!frame) return;
      const effectiveHistory =
        typeof frame.history_size === "number"
          ? frame.history_size
          : maxObservedOffsetRef.current;
      if (effectiveHistory !== committedHistorySizeRef.current) {
        committedHistorySizeRef.current = effectiveHistory;
        setHistorySize(effectiveHistory);
      }
    }, []);

    const pingScrollbar = useCallback(() => {
      syncVisibleHistorySize();
      setScrollbarVisible(true);
      if (scrollbarFadeTimerRef.current !== null) {
        window.clearTimeout(scrollbarFadeTimerRef.current);
      }
      scrollbarFadeTimerRef.current = window.setTimeout(() => {
        scrollbarFadeTimerRef.current = null;
        setScrollbarVisible(false);
      }, 1200);
    }, [syncVisibleHistorySize]);

    useEffect(
      () => () => {
        if (paintRafRef.current !== null) {
          window.cancelAnimationFrame(paintRafRef.current);
          paintRafRef.current = null;
        }
        if (scrollRafRef.current !== null) {
          window.cancelAnimationFrame(scrollRafRef.current);
          scrollRafRef.current = null;
        }
        if (scrollbarFadeTimerRef.current !== null) {
          window.clearTimeout(scrollbarFadeTimerRef.current);
          scrollbarFadeTimerRef.current = null;
        }
        if (resizeHudTimerRef.current !== null) {
          window.clearTimeout(resizeHudTimerRef.current);
          resizeHudTimerRef.current = null;
        }
        if (pendingCommitTimerRef.current !== null) {
          window.clearTimeout(pendingCommitTimerRef.current);
          pendingCommitTimerRef.current = null;
        }
        stopEdgeAutoScroll();
      },
      [stopEdgeAutoScroll],
    );

    const applyFrame = useCallback(
      (frame: NativeTermFrame, opts?: { sync?: boolean }) => {
        const prevOffset = frameRef.current?.display_offset ?? 0;
        // Never overwrite a warm cached frame with an empty native_term_open frame
        // before the first live WebSocket snapshot arrives.
        if (!hasLiveDataRef.current && !frameHasContent(frame) && frameHasContent(frameRef.current)) {
          return;
        }
        frameRef.current = frame;
        lastHoverCellRef.current = null;
        if (pendingCommitTextRef.current) {
          pendingCommitTextRef.current = "";
          if (pendingCommitTimerRef.current !== null) {
            window.clearTimeout(pendingCommitTimerRef.current);
            pendingCommitTimerRef.current = null;
          }
        }
        rememberFrame(terminalId, frame);
        if (frame.display_offset > maxObservedOffsetRef.current) {
          maxObservedOffsetRef.current = frame.display_offset;
        }
        if (
          (frame.wants_mouse || daemonBackedRef.current) &&
          frame.display_offset > 0 &&
          !searchOpenRef.current
        ) {
          // Remote app / pty-daemon / tmux owns scrollback via SGR mouse wheel;
          // keep local alacritty_terminal pinned to bottom so local offset never
          // drifts out of sync with the remote viewport.
          void enqueueTermOp(() =>
            invoke<NativeTermFrame>("native_term_snap_bottom", { id: terminalId }),
          )
            .then((snapped) => {
              frameRef.current = snapped;
              if (selectionRef.current) {
                const pointerCell =
                  draggingRef.current && lastPointerRef.current
                    ? pointerToSelectionCellRef.current(
                        lastPointerRef.current.clientX,
                        lastPointerRef.current.clientY,
                      )
                    : null;
                syncSelectionWithFrame(selectionRef.current, snapped, {
                  dragging: draggingRef.current,
                  pointerCell,
                  preferredDirection: lastRemoteScrollDirRef.current,
                });
              }
              paintFrame(snapped);
            })
            .catch(() => {});
          return;
        }
        if (selectionRef.current) {
          const pointerCell =
            draggingRef.current && lastPointerRef.current
              ? pointerToSelectionCellRef.current(
                  lastPointerRef.current.clientX,
                  lastPointerRef.current.clientY,
                )
              : null;
          syncSelectionWithFrame(selectionRef.current, frame, {
            dragging: draggingRef.current,
            pointerCell,
            preferredDirection: lastRemoteScrollDirRef.current,
          });
        }
        const effectiveHistory =
          typeof frame.history_size === "number"
            ? frame.history_size
            : maxObservedOffsetRef.current;
        const remoteOwns = Boolean(frame.wants_mouse) || daemonBackedRef.current;
        const now = performance.now();
        if (
          frame.display_offset !== prevOffset ||
          (frame.display_offset === 0) !== (prevOffset === 0) ||
          now - lastScrollBadgeUpdateRef.current > 80
        ) {
          lastScrollBadgeUpdateRef.current = now;
          if (frame.display_offset !== committedScrollbackOffsetRef.current) {
            committedScrollbackOffsetRef.current = frame.display_offset;
            setScrollbackOffset(frame.display_offset);
          }
          const needHistoryUpdate =
            !remoteOwns &&
            effectiveHistory !== committedHistorySizeRef.current &&
            (frame.display_offset > 0 ||
              scrollbarShownRef.current ||
              (committedHistorySizeRef.current === 0 && effectiveHistory > 0));
          if (needHistoryUpdate) {
            committedHistorySizeRef.current = effectiveHistory;
            setHistorySize(effectiveHistory);
          }
        }
        if (frame.display_offset !== prevOffset) {
          pingScrollbar();
        }
        if (frame.title && callbacksRef.current.onTitleChange) {
          callbacksRef.current.onTitleChange(frame.title);
        }
        if (frame.clipboard_write) {
          void copyToClipboardRef.current?.(frame.clipboard_write);
        }
        if (opts?.sync) {
          paintFrame(frame);
        } else {
          schedulePaint();
        }
        if (!readyFiredRef.current) {
          readyFiredRef.current = true;
          callbacksRef.current.onReady?.();
        }
      },
      [terminalId, enqueueTermOp, paintFrame, schedulePaint, pingScrollbar],
    );
    const applyFrameRef = useRef(applyFrame);
    applyFrameRef.current = applyFrame;

    const flushPendingScroll = useCallback(() => {
      scrollRafRef.current = null;
      if (scrollInFlightRef.current) return;
      const queued = pendingScrollLinesRef.current;
      if (queued === 0) return;
      // While drag-selecting, cap each local scroll step to < viewport height so
      // every intermediate line passes through applyFrame and is stitched into
      // selectionRef.current.lines with zero gaps.
      let deltaLines = queued;
      if (draggingRef.current && selectionRef.current) {
        const maxStep = Math.max(1, (frameRef.current?.rows ?? dimsRef.current.rows) - 2);
        if (Math.abs(deltaLines) > maxStep) {
          deltaLines = Math.sign(deltaLines) * maxStep;
        }
      }
      pendingScrollLinesRef.current = queued - deltaLines;
      scrollInFlightRef.current = true;
      void enqueueTermOp(() =>
        invoke<NativeTermFrame>("native_term_scroll", {
          id: terminalId,
          deltaLines,
        }),
      )
        .then((frame) => {
          applyFrameRef.current(frame);
        })
        .catch(() => {})
        .finally(() => {
          scrollInFlightRef.current = false;
          if (pendingScrollLinesRef.current !== 0 && scrollRafRef.current === null) {
            scrollRafRef.current = window.requestAnimationFrame(flushPendingScroll);
          }
        });
    }, [terminalId, enqueueTermOp]);

    const sendRawInput = useCallback(
      (data: string) => {
        if (!canType || !data) return;
        const transformed = inputTransformRef?.current ? inputTransformRef.current(data) : data;
        // Clear selection highlight on real keyboard input (preserve during SGR mouse events).
        if (selectionRef.current && !transformed.startsWith("\x1b[<")) {
          selectionRef.current = null;
          schedulePaint();
        }
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          if ((frameRef.current?.display_offset ?? 0) > 0) {
            void enqueueTermOp(() =>
              invoke<NativeTermFrame>("native_term_snap_bottom", { id: terminalId }),
            )
              .then((frame) => applyFrameRef.current(frame))
              .catch(() => {});
          }
          ws.send(JSON.stringify({ type: "input", data: transformed }));
        } else if (!transformed.startsWith("\x1b[<")) {
          // Queue non-mouse keystrokes during brief reconnects so initial typing isn't lost.
          pendingInputRef.current = (pendingInputRef.current + transformed).slice(-4096);
        }
      },
      [canType, inputTransformRef, terminalId, enqueueTermOp, schedulePaint],
    );

    const resizeLocalEmulator = useCallback(
      (cols: number, rows: number) => {
        const nextCols = Math.max(20, cols);
        const nextRows = Math.max(6, rows);
        ptyDimsRef.current = { cols: nextCols, rows: nextRows };
        void enqueueTermOp(() =>
          invoke<NativeTermFrame>("native_term_resize", {
            id: terminalId,
            cols: nextCols,
            rows: nextRows,
          }),
        )
          .then((frame) => applyFrameRef.current(frame))
          .catch(() => {});
      },
      [enqueueTermOp, terminalId],
    );

    const fitToContainer = useCallback(
      (opts?: { skipIfUnchanged?: boolean; immediate?: boolean }) => {
        const container = containerRef.current;
        if (!container) return;
        const rect = container.getBoundingClientRect();
        if (rect.width < 40 || rect.height < 40) return;
        containerSizeRef.current = { width: rect.width, height: rect.height };

        const { cellW, cellH } = measureCellMetrics();
        const cols = Math.max(20, Math.floor((rect.width - 20) / cellW));
        const rows = Math.max(6, Math.floor((rect.height - 12) / cellH));
        const unchanged = dimsRef.current.cols === cols && dimsRef.current.rows === rows;
        dimsRef.current = { cols, rows };
        if (hasInitialFitRef.current && !unchanged) {
          setResizeHud({ cols, rows, visible: true });
          if (resizeHudTimerRef.current !== null) {
            window.clearTimeout(resizeHudTimerRef.current);
          }
          resizeHudTimerRef.current = window.setTimeout(() => {
            resizeHudTimerRef.current = null;
            setResizeHud((prev) => ({ ...prev, visible: false }));
          }, 550);
        }
        hasInitialFitRef.current = true;

        const sendResizeNow = () => {
          if (!callbacksRef.current.canResizeTerminal) return;
          const ws = wsRef.current;
          if (!ws || ws.readyState !== WebSocket.OPEN) return;
          // Never send a no-op resize when the remote PTY is already at (cols, rows):
          // Linux ioctl(TIOCSWINSZ) delivers SIGWINCH even on same-size resizes, which
          // causes Ink/Claude/agy TUIs to duplicate lines and tear mid-stream.
          if (ptyDimsRef.current.cols === cols && ptyDimsRef.current.rows === rows) {
            lastSentResizeRef.current = { cols, rows };
            return;
          }
          const prevSent = lastSentResizeRef.current;
          if (opts?.skipIfUnchanged && prevSent && prevSent.cols === cols && prevSent.rows === rows) {
            return;
          }
          lastSentResizeRef.current = { cols, rows };
          ws.send(JSON.stringify({ type: "resize", cols, rows }));
          // Fallback local resize if remote PTY was already at (cols, rows) and Hub
          // does not emit a new TerminalResized event.
          if (resizeConfirmTimerRef.current !== null) {
            window.clearTimeout(resizeConfirmTimerRef.current);
          }
          resizeConfirmTimerRef.current = window.setTimeout(() => {
            resizeConfirmTimerRef.current = null;
            if (ptyDimsRef.current.cols !== cols || ptyDimsRef.current.rows !== rows) {
              resizeLocalEmulator(cols, rows);
            }
          }, 120);
        };

        if (canResizeTerminal) {
          if (opts?.immediate || !unchanged) {
            if (resizeDebounceTimerRef.current !== null) {
              window.clearTimeout(resizeDebounceTimerRef.current);
              resizeDebounceTimerRef.current = null;
            }
            if (opts?.immediate) {
              sendResizeNow();
            } else {
              resizeDebounceTimerRef.current = window.setTimeout(() => {
                resizeDebounceTimerRef.current = null;
                sendResizeNow();
              }, 75);
            }
          }
        }
      },
      [measureCellMetrics, canResizeTerminal, resizeLocalEmulator],
    );
    const fitToContainerRef = useRef(fitToContainer);
    fitToContainerRef.current = fitToContainer;

    // Open Rust alacritty_terminal instance at the remote PTY's current size so
    // the initial state_formatted() snapshot is ALWAYS parsed at exact matching width.
    useEffect(() => {
      readyFiredRef.current = false;
      lastSentResizeRef.current = null;
      remoteWheelActiveRef.current = false;
      daemonBackedRef.current = false;
      selectionRef.current = null;
      draggingRef.current = false;
      lastPointerRef.current = null;
      lastRemoteScrollDirRef.current = 0;
      stopEdgeAutoScroll();
      let cancelled = false;
      const openCols = ptyDimsRef.current.cols;
      const openRows = ptyDimsRef.current.rows;
      void enqueueTermOp(() =>
        invoke<NativeTermFrame>("native_term_open", {
          id: terminalId,
          cols: openCols,
          rows: openRows,
        }),
      )
        .then((frame) => {
          if (!cancelled) applyFrameRef.current(frame);
        })
        .catch(() => {});
      return () => {
        cancelled = true;
        if (resizeConfirmTimerRef.current !== null) {
          window.clearTimeout(resizeConfirmTimerRef.current);
          resizeConfirmTimerRef.current = null;
        }
        if (resizeDebounceTimerRef.current !== null) {
          window.clearTimeout(resizeDebounceTimerRef.current);
          resizeDebounceTimerRef.current = null;
        }
        void enqueueTermOp(() => invoke("native_term_close", { id: terminalId })).catch(() => {});
      };
    }, [terminalId, enqueueTermOp, stopEdgeAutoScroll]);

    // Single source of truth: whenever Hub reports the remote PTY's true size
    // (initial TerminalInfo or TerminalResized), lock local alacritty_terminal to it.
    useEffect(() => {
      const nextCols = Math.max(20, initialCols || 80);
      const nextRows = Math.max(6, initialRows || 24);
      if (ptyDimsRef.current.cols === nextCols && ptyDimsRef.current.rows === nextRows) {
        return;
      }
      if (resizeConfirmTimerRef.current !== null) {
        window.clearTimeout(resizeConfirmTimerRef.current);
        resizeConfirmTimerRef.current = null;
      }
      resizeLocalEmulator(nextCols, nextRows);
    }, [initialCols, initialRows, resizeLocalEmulator]);

    // Wait for bundled/custom terminal webfonts to finish loading before locking cellW.
    useEffect(() => {
      let disposed = false;
      measureCellMetrics();
      const loadFonts = async () => {
        try {
          await Promise.allSettled([
            document.fonts?.load(`${fontSize}px ${fontFamily}`),
            document.fonts?.load(`${fontSize}px "${DEFAULT_TERMINAL_FONT}"`),
            document.fonts?.load(`${fontSize}px "${TERMINAL_SYMBOL_FONT}"`, "⏵"),
          ]);
        } catch {
          // fall back to system monospace
        }
        if (disposed) return;
        measureCellMetrics();
        fitToContainer({ skipIfUnchanged: true, immediate: true });
        schedulePaint();
      };
      void loadFonts();
      return () => {
        disposed = true;
      };
    }, [fontSize, fontFamily, measureCellMetrics, fitToContainer, schedulePaint]);

    // Exact container ResizeObserver (zero setTimeout hacks!).
    // Always repaint on container resize so canvas backing-store dimensions stay
    // 1:1 with CSS size even while watching (e.g. mobile keyboard open/close).
    // On touch/mobile devices, NEVER send a remote PTY resize when only height
    // changes while the soft keyboard is open or dismissing: paintFrame already
    // anchors the active bottom & cursor above the keyboard via yOffset, avoiding
    // SIGWINCH redraws that make Ink/agy TUIs scroll from way up in history.
    useEffect(() => {
      const el = containerRef.current;
      if (!el) return;
      let lastWidth = el.getBoundingClientRect().width;
      let nativeKeyboardOpen = false;
      let keyboardDismissGraceUntil = 0;
      const isMobileTouch =
        typeof window !== "undefined" &&
        (window.matchMedia?.("(pointer: coarse)").matches ||
          "ontouchstart" in window);

      const onNativeKeyboard = (event: Event) => {
        const visible = (event as CustomEvent).detail;
        if (typeof visible !== "boolean") return;
        nativeKeyboardOpen = visible;
        if (!visible) {
          keyboardDismissGraceUntil = performance.now() + 600;
        }
      };
      const onFocusOut = () => {
        if (isMobileTouch) {
          keyboardDismissGraceUntil = performance.now() + 600;
        }
      };
      window.addEventListener("offdesk:keyboard-visibility", onNativeKeyboard);
      el.addEventListener("focusout", onFocusOut);

      const syncContainerSize = () => {
        const rect = el.getBoundingClientRect();
        if (rect.width >= 10 && rect.height >= 10) {
          containerSizeRef.current = { width: rect.width, height: rect.height };
        }
        return rect;
      };
      const handleResize = () => {
        const rect = syncContainerSize();
        const widthUnchanged = lastWidth > 0 && Math.abs(rect.width - lastWidth) < 2;
        if (rect.width >= 10) lastWidth = rect.width;
        const softKeyboardTransition =
          widthUnchanged &&
          (nativeKeyboardOpen ||
            (isMobileTouch && focusedRef.current) ||
            performance.now() < keyboardDismissGraceUntil);
        if (!softKeyboardTransition) {
          fitToContainer({ skipIfUnchanged: true });
        }
        schedulePaint();
      };
      const ro = new ResizeObserver(handleResize);
      ro.observe(el);
      const vv = window.visualViewport;
      vv?.addEventListener("resize", handleResize);
      syncContainerSize();
      fitToContainer({ skipIfUnchanged: false, immediate: true });
      schedulePaint();
      return () => {
        ro.disconnect();
        vv?.removeEventListener("resize", handleResize);
        window.removeEventListener("offdesk:keyboard-visibility", onNativeKeyboard);
        el.removeEventListener("focusout", onFocusOut);
      };
    }, [fitToContainer, schedulePaint]);

    // Repaint when theme, font, or search highlight changes.
    useEffect(() => {
      paintFrame(frameRef.current);
    }, [paintFrame, searchOpen, searchQuery]);

    // Repaint crisply when dragging the window across monitors with different DPI.
    useEffect(() => {
      let mq: MediaQueryList | null = null;
      const listen = () => {
        mq?.removeEventListener("change", onChange);
        mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
        mq.addEventListener("change", onChange);
      };
      const onChange = () => {
        schedulePaint();
        listen();
      };
      listen();
      return () => {
        mq?.removeEventListener("change", onChange);
      };
    }, [schedulePaint]);

    // Immediately reconnect if the WebSocket went closed, closing, or stuck connecting while sleeping/offline.
    useEffect(() => {
      const wakeCheck = () => {
        if (document.visibilityState === "hidden") return;
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          if (ws && ws.readyState === WebSocket.CONNECTING) {
            try { ws.close(); } catch { /* ignore */ }
          }
          setSessionGen((v) => v + 1);
        }
      };
      document.addEventListener("visibilitychange", wakeCheck);
      window.addEventListener("online", wakeCheck);
      return () => {
        document.removeEventListener("visibilitychange", wakeCheck);
        window.removeEventListener("online", wakeCheck);
      };
    }, []);

    // Live WebSocket stream with deflate-raw-v1 decompression + rAF batching into Rust alacritty_terminal.
    useEffect(() => {
      if (!wsUrl) return;
      let disposed = false;
      const ws = openSocket(wsUrl);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      const compression = createDeflateRawV1Session({
        onError: () => {
          // A corrupted deflate stream cannot recover in-place; force a clean reconnect.
          if (!disposed) {
            try { ws.close(); } catch { /* ignore */ }
          }
        },
      });
      let pendingChunks: Uint8Array[] = [];
      let rafId: number | null = null;
      let inFlight = false;
      let inSyncUpdate = false;
      let syncTail: Uint8Array = new Uint8Array(0);
      let syncGuardTimer: number | null = null;
      let syncStartAt = 0;

      const clearSyncGuard = () => {
        if (syncGuardTimer !== null) {
          window.clearTimeout(syncGuardTimer);
          syncGuardTimer = null;
        }
      };

      const flushToRust = () => {
        rafId = null;
        if (disposed || inFlight || pendingChunks.length === 0) return;
        if (inSyncUpdate) return;
        const batch = concatChunks(pendingChunks);
        pendingChunks = [];
        inFlight = true;
        void enqueueTermOp(() => {
          if (disposed) return Promise.resolve(null);
          return invoke<NativeTermFrame>("native_term_feed", {
            id: terminalId,
            dataB64: bytesToBase64(batch),
          });
        })
          .then((frame) => {
            if (frame && !disposed) {
              hasLiveDataRef.current = true;
              applyFrameRef.current(frame, { sync: true });
            }
          })
          .catch(() => {})
          .finally(() => {
            inFlight = false;
            if (!disposed && !inSyncUpdate && pendingChunks.length > 0 && rafId === null) {
              rafId = requestAnimationFrame(flushToRust);
            }
          });
      };

      const enqueueBytes = (bytes: Uint8Array) => {
        if (bytes.length === 0 || disposed) return;
        if (!daemonBackedRef.current && hasDaemonSnapshotHeader(bytes)) {
          daemonBackedRef.current = true;
        }
        pendingChunks.push(bytes);
        const scanned = scanSyncUpdateMarkers(syncTail, bytes, inSyncUpdate);
        syncTail = scanned.nextTail;
        inSyncUpdate = scanned.inSync;
        if (inSyncUpdate) {
          // Hold partial TUI redraw frames until ESU (\x1b[?2026l) arrives.
          // Extend on mid-sync chunks (120ms idle, 400ms max) so slow multi-frame
          // TUI redraws don't tear mid-frame, while a crashed app can never stall painting.
          const now = performance.now();
          if (syncStartAt === 0) syncStartAt = now;
          const remaining = Math.max(0, 400 - (now - syncStartAt));
          const delay = Math.min(120, remaining);
          clearSyncGuard();
          syncGuardTimer = window.setTimeout(() => {
            syncGuardTimer = null;
            syncStartAt = 0;
            inSyncUpdate = false;
            if (!disposed && !inFlight && pendingChunks.length > 0) {
              if (rafId !== null) {
                cancelAnimationFrame(rafId);
                rafId = null;
              }
              flushToRust();
            }
          }, delay);
          return;
        }
        clearSyncGuard();
        syncStartAt = 0;
        // Flush immediately when idle so interactive echo & sparse output have 0-rAF
        // local latency; bursts arriving while inFlight coalesce into 1 rAF in finally().
        if (!inFlight) {
          if (rafId !== null) {
            cancelAnimationFrame(rafId);
            rafId = null;
          }
          flushToRust();
        }
      };

      const reconnect = createTerminalReconnectController<number>({
        delayMs: 1000,
        resumeDelayMs: 0,
        openReadyState: WebSocket.OPEN,
        onReconnect: () => {
          if (!disposed) setSessionGen((v) => v + 1);
        },
        schedule: (cb, ms) => window.setTimeout(cb, ms),
        cancel: (id) => window.clearTimeout(id),
      });

      const handleVisibilityChange = () => {
        reconnect.handleVisibilityChange(document.visibilityState, ws.readyState);
        const pending = reconnect.hasPendingReconnect();
        if (pending) callbacksRef.current.onReconnectingChange?.(true);
      };
      const handlePageShow = () => {
        reconnect.handleVisibilityChange("visible", ws.readyState);
        const pending = reconnect.hasPendingReconnect();
        if (pending) callbacksRef.current.onReconnectingChange?.(true);
      };
      document.addEventListener("visibilitychange", handleVisibilityChange);
      window.addEventListener("pageshow", handlePageShow);

      ws.onopen = () => {
        if (disposed) return;
        reconnect.handleSocketOpen();
        callbacksRef.current.onReconnectingChange?.(false);
        lastSentResizeRef.current = null;
        fitToContainerRef.current({ skipIfUnchanged: false, immediate: true });
        if (pendingInputRef.current) {
          const queued = pendingInputRef.current;
          pendingInputRef.current = "";
          ws.send(JSON.stringify({ type: "input", data: queued }));
        }
      };

      ws.onmessage = (event) => {
        if (disposed) return;
        if (typeof event.data === "string") {
          compression.handleText(event.data);
          for (const listener of Array.from(controlListenersRef.current)) {
            listener(event.data);
          }
          return;
        }
        const buf = event.data as ArrayBuffer;
        const inflated = compression.handleBinary(buf);
        if (inflated === null) {
          enqueueBytes(new Uint8Array(buf));
        } else {
          for (const chunk of inflated) enqueueBytes(chunk);
        }
      };

      ws.onclose = () => {
        if (disposed) return;
        if (!readyFiredRef.current) {
          readyFiredRef.current = true;
          callbacksRef.current.onReady?.();
        }
        callbacksRef.current.onReconnectingChange?.(true);
        reconnect.scheduleReconnect();
      };
      ws.onerror = () => {
        if (disposed) return;
        if (!readyFiredRef.current) {
          readyFiredRef.current = true;
          callbacksRef.current.onReady?.();
        }
        callbacksRef.current.onReconnectingChange?.(true);
      };

      return () => {
        disposed = true;
        clearSyncGuard();
        if (rafId !== null) cancelAnimationFrame(rafId);
        reconnect.cancelReconnect();
        document.removeEventListener("visibilitychange", handleVisibilityChange);
        window.removeEventListener("pageshow", handlePageShow);
        ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
        ws.close();
        if (wsRef.current === ws) wsRef.current = null;
      };
    }, [wsUrl, terminalId, sessionGen, enqueueTermOp]);

    const [copiedToast, setCopiedToast] = useState(false);
    const copiedToastTimerRef = useRef<number | null>(null);

    const copyToClipboardRef = useRef<((text: string) => Promise<void>) | null>(null);
    const copyToClipboard = useCallback(async (text: string) => {
      if (!text) return;
      const showCopied = () => {
        setCopiedToast(true);
        if (copiedToastTimerRef.current !== null) {
          window.clearTimeout(copiedToastTimerRef.current);
        }
        copiedToastTimerRef.current = window.setTimeout(() => {
          copiedToastTimerRef.current = null;
          setCopiedToast(false);
        }, 1100);
      };
      try {
        const internals = (
          window as unknown as {
            __TAURI_INTERNALS__?: {
              invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
            };
          }
        ).__TAURI_INTERNALS__;
        if (typeof internals?.invoke === "function") {
          await internals.invoke("plugin:clipboard-manager|write_text", { text });
          showCopied();
          return;
        }
      } catch {
        // Fall through to web clipboard API.
      }
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
          showCopied();
          return;
        }
      } catch {
        // Fall through to execCommand fallback.
      }
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        showCopied();
      } catch {
        /* ignore */
      }
    }, []);
    copyToClipboardRef.current = copyToClipboard;

    const getSelectionText = useCallback((): string => {
      const sel = selectionRef.current;
      if (!sel) return "";
      return extractSelectionText(sel);
    }, []);

    useEffect(() => {
      const ensureEdgeAutoScroll = (clientY: number) => {
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect || !draggingRef.current) {
          stopEdgeAutoScroll();
          return;
        }
        const edgeMargin = 6;
        const outside = clientY < rect.top + edgeMargin || clientY > rect.bottom - edgeMargin;
        if (!outside) {
          stopEdgeAutoScroll();
          return;
        }
        if (edgeAutoScrollTimerRef.current !== null) return;
        edgeAutoScrollTimerRef.current = window.setInterval(() => {
          const ptr = lastPointerRef.current;
          const r = containerRef.current?.getBoundingClientRect();
          if (!draggingRef.current || !ptr || !r) {
            stopEdgeAutoScroll();
            return;
          }
          // Dispatch remote wheel events at the vertical midpoint of the viewport so
          // TUIs with fixed headers/footers (Claude Code, tmux) scroll their main pane.
          const midY = r.top + r.height / 2;
          if (ptr.clientY < r.top + edgeMargin) {
            const dist = Math.max(1, r.top + edgeMargin - ptr.clientY);
            const lines = Math.min(5, Math.max(1, Math.ceil(dist / 24)));
            scrollByLinesRef.current(lines, ptr.clientX, midY);
          } else if (ptr.clientY > r.bottom - edgeMargin) {
            const dist = Math.max(1, ptr.clientY - (r.bottom - edgeMargin));
            const lines = -Math.min(5, Math.max(1, Math.ceil(dist / 24)));
            scrollByLinesRef.current(lines, ptr.clientX, midY);
          } else {
            stopEdgeAutoScroll();
          }
        }, 75);
      };

      const onWinMouseMove = (e: MouseEvent) => {
        if (!draggingRef.current || !selectionRef.current) return;
        lastPointerRef.current = { clientX: e.clientX, clientY: e.clientY };
        selectionRef.current = updateSelectionEnd(
          selectionRef.current,
          pointerToSelectionCellRef.current(e.clientX, e.clientY),
        );
        ensureEdgeAutoScroll(e.clientY);
        schedulePaint();
      };
      const onWinMouseUp = () => {
        stopEdgeAutoScroll();
        lastPointerRef.current = null;
        if (!draggingRef.current) return;
        draggingRef.current = false;
        const text = getSelectionText();
        if (text) {
          void copyToClipboard(text);
        }
      };
      const onDocCopy = (e: ClipboardEvent) => {
        if (document.activeElement !== inputRef.current) return;
        const text = getSelectionText();
        if (!text) return;
        e.preventDefault();
        e.clipboardData?.setData("text/plain", text);
        void copyToClipboard(text);
      };
      window.addEventListener("mousemove", onWinMouseMove);
      window.addEventListener("mouseup", onWinMouseUp);
      document.addEventListener("copy", onDocCopy);
      return () => {
        stopEdgeAutoScroll();
        window.removeEventListener("mousemove", onWinMouseMove);
        window.removeEventListener("mouseup", onWinMouseUp);
        document.removeEventListener("copy", onDocCopy);
      };
    }, [getSelectionText, copyToClipboard, schedulePaint, stopEdgeAutoScroll]);

    useImperativeHandle(
      ref,
      () => ({
        sendInput: sendRawInput,
        pasteText: (text: string) => {
          const payload = frameRef.current?.bracketed_paste
            ? `\x1b[200~${text}\x1b[201~`
            : text;
          sendRawInput(payload);
        },
        sendCommandInput: (data: string) => {
          const ws = wsRef.current;
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "command_input", data }));
          }
        },
        fitToContainer,
        scrollToBottom: () => {
          void enqueueTermOp(() =>
            invoke<NativeTermFrame>("native_term_snap_bottom", { id: terminalId }),
          )
            .then((frame) => applyFrameRef.current(frame))
            .catch(() => {});
        },
        focus: () => inputRef.current?.focus(),
        blur: () => inputRef.current?.blur(),
        sendImageFile: async (file, onProgress) => {
          const ws = await waitForWsOpen(() => wsRef.current, 5000);
          if (!ws) throw new Error("Terminal socket is not open");
          try {
            await uploadFileChunked({
              file,
              onProgress,
              subscribe: subscribeControl,
              send: (text) => {
                if (ws.readyState !== WebSocket.OPEN) {
                  throw new UploadError("disconnected", "Connection lost during upload.");
                }
                ws.send(text);
              },
            });
          } catch (error) {
            if (uploadFallsBackToLegacy(error, file.size)) {
              if (file.size > MAX_IMAGE_PASTE_BYTES) {
                throw new Error("File exceeds maximum paste size");
              }
              const { base64, mime } = await readFileAsBase64(file);
              const ext = mime.includes("/") ? `.${mime.split("/")[1]}` : ".png";
              ws.send(
                JSON.stringify(
                  buildImagePasteMessage(base64, mime, safeFilename(file.name ?? "", ext)),
                ),
              );
              return;
            }
            throw error;
          }
        },
        setMouseTrackingEnabled: () => {},
        getSelection: getSelectionText,
        getSelectionSnapshot: (): SelectionSnapshot | null => {
          const frame = frameRef.current;
          if (!frame) return null;
          const lines = frame.spans.map((rowSpans) => {
            const chars = new Array<string>(frame.cols).fill(" ");
            for (const sp of rowSpans) {
              let col = sp.c;
              for (const ch of sp.t) {
                if (col < frame.cols) chars[col] = ch;
                col += 1;
              }
            }
            return chars.join("").trimEnd();
          });
          return { lines, fontFamily, fontSize };
        },
      }),
      [sendRawInput, fitToContainer, terminalId, applyFrame, getSelectionText, fontFamily, fontSize],
    );

    const uploadFiles = useCallback(
      async (files: File[]) => {
        if (!canType || files.length === 0 || uploadLockRef.current) return;
        uploadLockRef.current = true;
        try {
          for (const file of files) {
            const name = file.name || "pasted-file";
            setUploadStatus({ text: `Uploading ${name}`, sent: 0, total: file.size });
            try {
              const ws = await waitForWsOpen(() => wsRef.current, 5000);
              if (!ws) throw new Error("Terminal socket is not open");
              try {
                await uploadFileChunked({
                  file,
                  onProgress: (sent, total) => setUploadStatus({ text: `Uploading ${name}`, sent, total }),
                  subscribe: subscribeControl,
                  send: (text) => {
                    if (ws.readyState !== WebSocket.OPEN) {
                      throw new UploadError("disconnected", "Connection lost during upload.");
                    }
                    ws.send(text);
                  },
                });
              } catch (err) {
                if (uploadFallsBackToLegacy(err, file.size)) {
                  const { base64, mime } = await readFileAsBase64(file);
                  const ext = mime.includes("/") ? `.${mime.split("/")[1]}` : "";
                  ws.send(
                    JSON.stringify(
                      buildImagePasteMessage(base64, mime, safeFilename(file.name ?? "", ext)),
                    ),
                  );
                } else {
                  throw err;
                }
              }
              setUploadStatus({ text: `Uploaded ${name}` });
            } catch (err) {
              setUploadStatus({
                text: `${name}: ${err instanceof Error ? err.message : "Upload failed"}`,
                error: true,
              });
              break;
            }
          }
        } finally {
          uploadLockRef.current = false;
        }
      },
      [canType, subscribeControl],
    );

    const rowToPlainString = useCallback((row: number): string => {
      const frame = frameRef.current;
      if (!frame || row < 0 || row >= frame.spans.length) return "";
      const chars = new Array<string>(frame.cols).fill(" ");
      for (const sp of frame.spans[row] ?? []) {
        let col = sp.c;
        for (const ch of sp.t) {
          const cp = ch.codePointAt(0) ?? 0;
          const w = isWideChar(cp) ? 2 : 1;
          if (col < frame.cols) chars[col] = ch;
          if (w === 2 && col + 1 < frame.cols) chars[col + 1] = "";
          col += w;
        }
      }
      return chars.join("");
    }, []);

    const tokenAtCell = useCallback(
      (col: number, row: number): { token: string; startCol: number; endCol: number } | null => {
        const frame = frameRef.current;
        if (!frame || row < 0 || row >= frame.spans.length) return null;
        const cells = new Array<string>(frame.cols).fill(" ");
        for (const sp of frame.spans[row] ?? []) {
          let c = sp.c;
          for (const ch of sp.t) {
            const cp = ch.codePointAt(0) ?? 0;
            const w = isWideChar(cp) ? 2 : 1;
            if (c < frame.cols) cells[c] = ch;
            if (w === 2 && c + 1 < frame.cols) cells[c + 1] = "";
            c += w;
          }
        }
        const isTokenChar = (ch: string) =>
          ch !== "" && !/[\s'"()[\]{}<>,;`：，。；！？（）【】「」『』《》、·—…“”‘’]/.test(ch);
        const rowCells = (r: number): string[] => {
          const out = new Array<string>(frame.cols).fill(" ");
          for (const sp of frame.spans[r] ?? []) {
            let c = sp.c;
            for (const ch of sp.t) {
              const cp = ch.codePointAt(0) ?? 0;
              const w = isWideChar(cp) ? 2 : 1;
              if (c < frame.cols) out[c] = ch;
              if (w === 2 && c + 1 < frame.cols) out[c + 1] = "";
              c += w;
            }
          }
          return out;
        };
        let c0 = Math.min(col, frame.cols - 1);
        if (c0 < 0) return null;
        if (cells[c0] === "" && c0 > 0) c0 -= 1;
        if (!isTokenChar(cells[c0])) return null;
        let start = c0;
        while (start > 0 && (cells[start - 1] === "" || isTokenChar(cells[start - 1]))) {
          start -= 1;
        }
        let end = c0 + 1;
        while (end < frame.cols && (cells[end] === "" || isTokenChar(cells[end]))) {
          end += 1;
        }
        let fullToken = cells.slice(start, end).join("");

        // Join soft-wrapped continuation lines above (when token begins at col 0 or indented wrap)
        // and below (when token reaches the right edge of the row).
        let upRow = row;
        let curStart = start;
        for (let step = 0; step < 3 && upRow > 0; step++) {
          const prevWrapped = Boolean(frame.wrapped_rows?.[upRow - 1]);
          // Some TUIs (Claude Code) hard-indent wrapped lines by 2 spaces after a path wraps at col >= cols - 4.
          const prevCells = rowCells(upRow - 1);
          let prevLast = frame.cols - 1;
          while (prevLast > 0 && prevCells[prevLast] === " ") prevLast -= 1;
          const prevHitRight = prevWrapped || (prevLast >= frame.cols - 6 && isTokenChar(prevCells[prevLast]));
          if (!prevHitRight) break;
          if (curStart > 2) break;
          if (curStart > 0 && cells.slice(0, curStart).some((ch) => ch !== " ")) break;
          if (!isTokenChar(prevCells[prevLast])) break;
          let pStart = prevLast;
          while (pStart > 0 && (prevCells[pStart - 1] === "" || isTokenChar(prevCells[pStart - 1]))) {
            pStart -= 1;
          }
          fullToken = prevCells.slice(pStart, prevLast + 1).join("") + fullToken;
          upRow -= 1;
          curStart = pStart;
        }

        let downRow = row;
        let curEnd = end;
        for (let step = 0; step < 3 && downRow + 1 < frame.spans.length; step++) {
          const curWrapped = Boolean(frame.wrapped_rows?.[downRow]);
          if (!curWrapped && curEnd < frame.cols - 5) break;
          const nextCells = rowCells(downRow + 1);
          let nStart = 0;
          if (!curWrapped) {
            while (nStart < 2 && nextCells[nStart] === " ") nStart += 1;
          }
          if (nStart >= frame.cols || !isTokenChar(nextCells[nStart])) break;
          let nEnd = nStart + 1;
          while (nEnd < frame.cols && (nextCells[nEnd] === "" || isTokenChar(nextCells[nEnd]))) {
            nEnd += 1;
          }
          fullToken += nextCells.slice(nStart, nEnd).join("");
          downRow += 1;
          curEnd = nEnd;
        }

        const token = fullToken.replace(/[.:]+$/, "");
        if (!token) return null;
        return { token, startCol: start, endCol: end };
      },
      [],
    );

    const closeSearchBar = useCallback(() => {
      setSearchOpen(false);
      activeSearchLineRef.current = null;
      if (
        (frameRef.current?.wants_mouse || daemonBackedRef.current) &&
        (frameRef.current?.display_offset ?? 0) > 0
      ) {
        void enqueueTermOp(() =>
          invoke<NativeTermFrame>("native_term_snap_bottom", { id: terminalId }),
        )
          .then(applyFrame)
          .catch(() => {});
      } else {
        paintFrame(frameRef.current);
      }
      inputRef.current?.focus();
    }, [terminalId, enqueueTermOp, applyFrame, paintFrame]);

    const openSearchBar = useCallback(() => {
      setSearchOpen(true);
      void enqueueTermOp(() => invoke<string[]>("native_term_plain_lines", { id: terminalId }))
        .then((lines) => {
          plainLinesRef.current = lines;
          setSearchLinesGen((v) => v + 1);
        })
        .catch(() => {});
      window.setTimeout(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }, 0);
    }, [terminalId, enqueueTermOp]);

    const jumpToSearchMatch = useCallback(
      (matches: number[], idx: number) => {
        if (matches.length === 0) {
          activeSearchLineRef.current = null;
          paintFrame(frameRef.current);
          return;
        }
        const wrapped = ((idx % matches.length) + matches.length) % matches.length;
        setSearchIndex(wrapped);
        const total = plainLinesRef.current.length;
        const lineIdx = matches[wrapped];
        activeSearchLineRef.current = lineIdx;
        const rows = frameRef.current?.rows ?? dimsRef.current.rows;
        const maxOff = frameRef.current?.history_size ?? Math.max(0, total - rows);
        const curOff = frameRef.current?.display_offset ?? 0;
        const targetOff = Math.max(0, Math.min(maxOff, total - lineIdx - Math.ceil(rows / 2)));
        const deltaLines = targetOff - curOff;
        if (deltaLines !== 0) {
          void enqueueTermOp(() =>
            invoke<NativeTermFrame>("native_term_scroll", { id: terminalId, deltaLines }),
          )
            .then((scrolled) => applyFrame(scrolled, { sync: true }))
            .catch(() => {});
        } else {
          paintFrame(frameRef.current);
        }
      },
      [terminalId, enqueueTermOp, applyFrame, paintFrame],
    );

    useEffect(() => {
      if (!searchOpen) return;
      const q = searchQuery.trim().toLowerCase();
      if (!q) {
        activeSearchLineRef.current = null;
        setSearchMatches([]);
        setSearchIndex(0);
        paintFrame(frameRef.current);
        return;
      }
      const lines = plainLinesRef.current;
      const found: number[] = [];
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].toLowerCase().includes(q)) found.push(i);
      }
      setSearchMatches(found);
      if (found.length > 0) {
        jumpToSearchMatch(found, 0);
      } else {
        activeSearchLineRef.current = null;
        paintFrame(frameRef.current);
      }
    }, [searchOpen, searchQuery, searchLinesGen, jumpToSearchMatch, paintFrame]);

    useEffect(() => {
      if (!ctxMenu) return;
      const close = () => setCtxMenu(null);
      window.addEventListener("mousedown", close);
      window.addEventListener("blur", close);
      return () => {
        window.removeEventListener("mousedown", close);
        window.removeEventListener("blur", close);
      };
    }, [ctxMenu]);

    const pointerToCell = (clientX: number, clientY: number) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return { col: 0, row: 0 };
      const { cellW, cellH } = metricsRef.current;
      const maxCols = frameRef.current?.cols ?? dimsRef.current.cols;
      const maxRows = frameRef.current?.rows ?? dimsRef.current.rows;
      const col = Math.max(0, Math.floor((clientX - rect.left - 8) / cellW));
      const row = Math.max(0, Math.floor((clientY - rect.top - 6 - paintOffsetYRef.current) / cellH));
      return {
        col: Math.min(col, maxCols),
        row: Math.min(row, Math.max(0, maxRows - 1)),
      };
    };

    const pointerToSelectionCell = (clientX: number, clientY: number) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return { col: 0, row: 0 };
      const maxCols = frameRef.current?.cols ?? dimsRef.current.cols;
      const maxRows = frameRef.current?.rows ?? dimsRef.current.rows;
      const isRectangular = Boolean(selectionRef.current?.rectangular);
      if (clientY < rect.top + 6) {
        return { col: isRectangular ? pointerToCell(clientX, clientY).col : 0, row: 0 };
      }
      if (clientY > rect.bottom - 6) {
        return {
          col: isRectangular ? pointerToCell(clientX, clientY).col : maxCols,
          row: Math.max(0, maxRows - 1),
        };
      }
      return pointerToCell(clientX, clientY);
    };
    pointerToSelectionCellRef.current = pointerToSelectionCell;

    const scrollByLines = (lines: number, clientX: number, clientY: number) => {
      if (lines === 0) return;
      const frame = frameRef.current;
      const hist = frame?.history_size ?? 0;
      const off = frame?.display_offset ?? 0;
      if (hist > 5 && !frame?.wants_mouse && !daemonBackedRef.current) {
        remoteWheelActiveRef.current = false;
      }
      const sendRemoteWheel =
        Boolean(frame?.wants_mouse) ||
        daemonBackedRef.current ||
        hist <= 5 ||
        (remoteWheelActiveRef.current && off === 0);
      if (sendRemoteWheel) {
        lastRemoteScrollDirRef.current = lines > 0 ? 1 : -1;
        if (!frame?.wants_mouse) {
          remoteWheelActiveRef.current = true;
        }
        if (off > 0) {
          void enqueueTermOp(() =>
            invoke<NativeTermFrame>("native_term_snap_bottom", { id: terminalId }),
          )
            .then((f) => applyFrameRef.current(f))
            .catch(() => {});
        }
        const btn = lines > 0 ? 64 : 65;
        // When a selection is active, cap each remote wheel burst to 2 events (<= 6 lines
        // in pty-daemon) so consecutive remote frames always overlap for scroll stitching,
        // even in short split panes or TUIs with fixed headers/footers.
        const maxCount = selectionRef.current ? 2 : 5;
        const count = Math.min(maxCount, Math.max(1, Math.abs(lines)));
        const cell = pointerToCell(clientX, clientY);
        let seq = "";
        for (let i = 0; i < count; i++) {
          seq += `\x1b[<${btn};${cell.col + 1};${cell.row + 1}M`;
        }
        sendRawInput(seq);
      } else {
        pendingScrollLinesRef.current += lines;
        if (!scrollInFlightRef.current && scrollRafRef.current === null) {
          scrollRafRef.current = window.requestAnimationFrame(flushPendingScroll);
        }
      }
    };
    scrollByLinesRef.current = scrollByLines;

    const scrollToTrackClientY = useCallback(
      (clientY: number) => {
        const track = scrollbarTrackRef.current;
        const frame = frameRef.current;
        if (!track || !frame) return;
        const maxOff =
          typeof frame.history_size === "number"
            ? frame.history_size
            : maxObservedOffsetRef.current;
        if (maxOff <= 0) return;
        const rect = track.getBoundingClientRect();
        if (rect.height <= 0) return;
        const ratio = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
        const targetOffset = Math.round((1 - ratio) * maxOff);
        const deltaLines = targetOffset - frame.display_offset;
        if (deltaLines === 0) return;
        pingScrollbar();
        pendingScrollLinesRef.current = deltaLines;
        if (!scrollInFlightRef.current && scrollRafRef.current === null) {
          scrollRafRef.current = window.requestAnimationFrame(flushPendingScroll);
        }
      },
      [flushPendingScroll, pingScrollbar],
    );

    useEffect(() => {
      const onMove = (e: MouseEvent) => {
        if (!scrollbarDragRef.current) return;
        e.preventDefault();
        scrollToTrackClientY(e.clientY);
      };
      const onUp = () => {
        scrollbarDragRef.current = false;
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      return () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
    }, [scrollToTrackClientY]);

    const visibleRows = frameRef.current?.rows ?? dimsRef.current.rows;
    const remoteOwnsScroll =
      Boolean(frameRef.current?.wants_mouse) ||
      daemonBackedRef.current ||
      (remoteWheelActiveRef.current && historySize <= 5);
    const totalLines = Math.max(visibleRows, visibleRows + historySize);
    const hasScrollback = !remoteOwnsScroll && (historySize > 0 || scrollbackOffset > 0);
    const thumbHeightPct = hasScrollback
      ? Math.max(8, Math.min(100, (visibleRows / totalLines) * 100))
      : 100;
    const thumbTopPct =
      hasScrollback && historySize > 0
        ? ((historySize - Math.min(scrollbackOffset, historySize)) / historySize) *
          (100 - thumbHeightPct)
        : 100 - thumbHeightPct;
    const showScrollbar =
      hasScrollback && (scrollbarVisible || scrollbarHover || scrollbarDragRef.current || scrollbackOffset > 0);
    scrollbarShownRef.current = showScrollbar;

    return (
      <div
        ref={containerRef}
        data-testid="native-terminal-view"
        onDragOver={(e) => {
          if (e.dataTransfer?.types.includes("Files")) {
            e.preventDefault();
          }
        }}
        onDrop={(e) => {
          const files = Array.from(e.dataTransfer?.files ?? []);
          if (files.length > 0) {
            e.preventDefault();
            void uploadFiles(files);
          }
        }}
        onMouseDown={(e) => {
          setCtxMenu(null);
          if (e.button === 0) {
            e.preventDefault();
          }
          inputRef.current?.focus({ preventScroll: true });
          if (e.button !== 0) return;
          stopEdgeAutoScroll();
          lastRemoteScrollDirRef.current = 0;
          const cell = pointerToCell(e.clientX, e.clientY);
          const frame = frameRef.current;
          if (e.detail === 2) {
            const tok = tokenAtCell(cell.col, cell.row);
            if (tok && frame) {
              selectionRef.current = createSelection(
                frame,
                { col: tok.startCol, row: cell.row },
                { col: tok.endCol, row: cell.row },
                false,
              );
              draggingRef.current = false;
              lastPointerRef.current = null;
              schedulePaint();
              void copyToClipboard(tok.token);
              return;
            }
          }
          if (e.detail >= 3) {
            const lineText = rowToPlainString(cell.row).trimEnd();
            if (frame) {
              selectionRef.current = createSelection(
                frame,
                { col: 0, row: cell.row },
                { col: frame.cols, row: cell.row },
                false,
              );
            }
            draggingRef.current = false;
            lastPointerRef.current = null;
            schedulePaint();
            if (lineText) void copyToClipboard(lineText);
            return;
          }
          if (frame) {
            selectionRef.current = createSelection(frame, cell, cell, e.altKey);
          } else {
            selectionRef.current = null;
          }
          draggingRef.current = true;
          lastPointerRef.current = { clientX: e.clientX, clientY: e.clientY };
          schedulePaint();
        }}
        onMouseLeave={() => {
          lastHoverCellRef.current = null;
          if (hoverLinkRef.current) {
            hoverLinkRef.current = null;
            setHoverPointer(false);
            schedulePaint();
          }
        }}
        onMouseMove={(e) => {
          // Drag selection updates (including edge auto-scroll & repaint) are handled
          // once per event by window `onWinMouseMove`.
          if (draggingRef.current && selectionRef.current) {
            return;
          }
          const cell = pointerToCell(e.clientX, e.clientY);
          const prevCell = lastHoverCellRef.current;
          if (prevCell && prevCell.col === cell.col && prevCell.row === cell.row) {
            return;
          }
          lastHoverCellRef.current = cell;
          const rowSpans = frameRef.current?.spans[cell.row] ?? [];
          let nextLink: { row: number; startCol: number; endCol: number } | null = null;
          for (const sp of rowSpans) {
            if (!sp.h) continue;
            let spanEnd = sp.c;
            for (const ch of sp.t) spanEnd += isWideChar(ch.codePointAt(0) ?? 0) ? 2 : 1;
            if (cell.col >= sp.c && cell.col < spanEnd) {
              nextLink = { row: cell.row, startCol: sp.c, endCol: spanEnd };
              break;
            }
          }
          if (!nextLink) {
            const tok = tokenAtCell(cell.col, cell.row);
            const looksLikeLink =
              tok &&
              (/^https?:\/\//i.test(tok.token) ||
                /^file:\/\//i.test(tok.token) ||
                /^(?:\/|~\/|\.\/|\.\.\/)/.test(tok.token) ||
                (tok.token.includes("/") && /\.[a-z0-9]{1,8}$/i.test(tok.token.replace(/:\d+(?::\d+)?$/, ""))));
            if (looksLikeLink && tok) {
              nextLink = { row: cell.row, startCol: tok.startCol, endCol: tok.endCol };
            }
          }
          const prev = hoverLinkRef.current;
          const changed =
            prev?.row !== nextLink?.row ||
            prev?.startCol !== nextLink?.startCol ||
            prev?.endCol !== nextLink?.endCol;
          if (changed) {
            hoverLinkRef.current = nextLink;
            setHoverPointer(Boolean(nextLink));
            schedulePaint();
          }
        }}
        onMouseUp={(e) => {
          stopEdgeAutoScroll();
          lastPointerRef.current = null;
          if (!draggingRef.current) return;
          draggingRef.current = false;
          const text = getSelectionText();
          if (text) {
            void copyToClipboard(text);
            return;
          }
          const cell = pointerToCell(e.clientX, e.clientY);
          // 1. Direct click on OSC 8 hyperlink, URL, or remote file path opens preview / browser.
          const rowSpans = frameRef.current?.spans[cell.row] ?? [];
          for (const sp of rowSpans) {
            if (!sp.h) continue;
            let spanEnd = sp.c;
            for (const ch of sp.t) spanEnd += isWideChar(ch.codePointAt(0) ?? 0) ? 2 : 1;
            if (cell.col >= sp.c && cell.col < spanEnd) {
              if (/^https?:\/\//i.test(sp.h)) {
                openExternalUrl(sp.h);
              } else if (onOpenDirectory && machineId) {
                const cleaned = sp.h.replace(/^file:\/\/[^/]*/i, "").replace(/:\d+(?::\d+)?$/, "");
                const resolved = resolveRemotePath(cleaned, cwd) ?? cleaned;
                onOpenDirectory(machineId, resolved);
              }
              return;
            }
          }
          const tok = tokenAtCell(cell.col, cell.row);
          if (tok) {
            if (/^https?:\/\//i.test(tok.token)) {
              openExternalUrl(tok.token);
              return;
            }
            const cleaned = tok.token.replace(/^file:\/\//i, "").replace(/:\d+(?::\d+)?$/, "");
            const isExplicitPath =
              /^(?:\/|~\/|\.\/|\.\.\/)/.test(cleaned) ||
              (cleaned.includes("/") && /\.[a-z0-9]{1,8}$/i.test(cleaned)) ||
              ((e.metaKey || e.ctrlKey) && (cleaned.includes("/") || /\.[a-z0-9]{1,8}$/i.test(cleaned)));
            if (onOpenDirectory && machineId && isExplicitPath) {
              const resolved = resolveRemotePath(cleaned, cwd) ?? cleaned;
              onOpenDirectory(machineId, resolved);
              return;
            }
          }
          // 2. Non-drag plain click in a mouse-aware TUI (e.g. Claude Code "Jump to bottom")
          if (
            (frameRef.current?.wants_mouse || daemonBackedRef.current) &&
            !e.shiftKey &&
            !e.altKey &&
            !e.metaKey &&
            !e.ctrlKey
          ) {
            sendRawInput(
              `\x1b[<0;${cell.col + 1};${cell.row + 1}M\x1b[<0;${cell.col + 1};${cell.row + 1}m`,
            );
          }
        }}
        onWheel={(e) => {
          e.preventDefault();
          if (draggingRef.current) {
            lastPointerRef.current = { clientX: e.clientX, clientY: e.clientY };
          }
          const stepPx = Math.max(12, lineHeight);
          const deltaPx =
            e.deltaMode === 1
              ? e.deltaY * stepPx * 3
              : e.deltaMode === 2
                ? e.deltaY * (frameRef.current?.rows ?? 24) * stepPx
                : e.deltaY;
          if (deltaPx === 0) return;

          // Clear residual accumulation if scroll direction reverses so reversing feels instant.
          if (
            (deltaPx > 0 && wheelAccumPxRef.current < 0) ||
            (deltaPx < 0 && wheelAccumPxRef.current > 0)
          ) {
            wheelAccumPxRef.current = 0;
          }
          wheelAccumPxRef.current += deltaPx;
          const lines = Math.trunc(-wheelAccumPxRef.current / stepPx);
          if (lines === 0) return;
          wheelAccumPxRef.current += lines * stepPx;

          scrollByLines(lines, e.clientX, e.clientY);
        }}
        onTouchStart={(e) => {
          if (e.touches.length !== 1) {
            touchScrollRef.current = null;
            return;
          }
          const t = e.touches[0];
          touchScrollRef.current = {
            lastY: t.clientY,
            accumPx: 0,
            clientX: t.clientX,
            clientY: t.clientY,
          };
        }}
        onTouchMove={(e) => {
          const state = touchScrollRef.current;
          if (!state || e.touches.length !== 1) return;
          const t = e.touches[0];
          const dy = t.clientY - state.lastY;
          state.lastY = t.clientY;
          state.clientX = t.clientX;
          state.clientY = t.clientY;
          if (dy === 0) return;

          const stepPx = Math.max(12, lineHeight);
          if ((dy > 0 && state.accumPx < 0) || (dy < 0 && state.accumPx > 0)) {
            state.accumPx = 0;
          }
          state.accumPx += dy;
          // Dragging finger DOWN (dy > 0) scrolls UP into older scrollback (+lines).
          const lines = Math.trunc(state.accumPx / stepPx);
          if (lines === 0) return;
          state.accumPx -= lines * stepPx;

          if (frameRef.current?.wants_mouse || daemonBackedRef.current) {
            const btn = lines > 0 ? 64 : 65;
            const count = Math.min(5, Math.max(1, Math.abs(lines)));
            const cell = pointerToCell(t.clientX, t.clientY);
            let seq = "";
            for (let i = 0; i < count; i++) {
              seq += `\x1b[<${btn};${cell.col + 1};${cell.row + 1}M`;
            }
            sendRawInput(seq);
          } else {
            pendingScrollLinesRef.current += lines;
            if (!scrollInFlightRef.current && scrollRafRef.current === null) {
              scrollRafRef.current = window.requestAnimationFrame(flushPendingScroll);
            }
          }
        }}
        onTouchEnd={() => {
          touchScrollRef.current = null;
        }}
        onTouchCancel={() => {
          touchScrollRef.current = null;
        }}
        style={{
          position: "relative",
          flex: 1,
          width: "100%",
          height: "100%",
          minHeight: 0,
          overflow: "hidden",
          touchAction: "none",
          cursor: hoverPointer ? "pointer" : "text",
          userSelect: "none",
          WebkitUserSelect: "none",
          background: theme.background ?? "#131415",
          ...style,
        }}
      >
        <canvas
          ref={canvasRef}
          style={{
            display: "block",
            width: "100%",
            height: "100%",
          }}
        />
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            transform: resizeHud.visible
              ? "translate(-50%, -50%) scale(1)"
              : "translate(-50%, -50%) scale(0.94)",
            opacity: resizeHud.visible ? 1 : 0,
            transition: "opacity 150ms ease, transform 150ms cubic-bezier(0.16, 1, 0.3, 1)",
            pointerEvents: "none",
            zIndex: 10,
            padding: "5px 12px",
            borderRadius: 999,
            border: "1px solid rgba(255,255,255,0.14)",
            background: "rgba(22, 23, 27, 0.92)",
            color: "#e4e4e7",
            fontFamily: "var(--font-mono, monospace)",
            fontSize: 12,
            fontWeight: 500,
            fontVariantNumeric: "tabular-nums",
            letterSpacing: "0.02em",
            boxShadow: "0 6px 20px rgba(0, 0, 0, 0.35)",
          }}
        >
          {resizeHud.cols} × {resizeHud.rows}
        </div>
        <textarea
          ref={inputRef}
          aria-label="Terminal input"
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onFocus={() => {
            focusedRef.current = true;
            schedulePaint();
          }}
          onBlur={(e) => {
            focusedRef.current = false;
            composingRef.current = false;
            compositionTextRef.current = "";
            pendingCommitTextRef.current = "";
            if (pendingCommitTimerRef.current !== null) {
              window.clearTimeout(pendingCommitTimerRef.current);
              pendingCommitTimerRef.current = null;
            }
            e.currentTarget.value = "";
            schedulePaint();
          }}
          onCompositionStart={() => {
            composingRef.current = true;
            compositionTextRef.current = "";
            pendingCommitTextRef.current = "";
            if (pendingCommitTimerRef.current !== null) {
              window.clearTimeout(pendingCommitTimerRef.current);
              pendingCommitTimerRef.current = null;
            }
          }}
          onCompositionUpdate={(e) => {
            composingRef.current = true;
            compositionTextRef.current = e.data ?? e.currentTarget.value ?? "";
            schedulePaint();
          }}
          onCompositionEnd={(e) => {
            composingRef.current = false;
            compositionEndAtRef.current = performance.now();
            compositionTextRef.current = "";
            const text = e.data || e.currentTarget.value;
            if (text) {
              sendRawInput(text);
              pendingCommitTextRef.current = text;
              if (pendingCommitTimerRef.current !== null) {
                window.clearTimeout(pendingCommitTimerRef.current);
              }
              pendingCommitTimerRef.current = window.setTimeout(() => {
                pendingCommitTimerRef.current = null;
                if (pendingCommitTextRef.current) {
                  pendingCommitTextRef.current = "";
                  schedulePaint();
                }
              }, 120);
            }
            e.currentTarget.value = "";
            schedulePaint();
          }}
          onInput={(e) => {
            if (composingRef.current || (e.nativeEvent as InputEvent).isComposing) return;
            const text = e.currentTarget.value;
            if (text) {
              sendRawInput(text);
              e.currentTarget.value = "";
            }
          }}
          onKeyDown={(e) => {
            const nativeKeyCode = (e.nativeEvent as KeyboardEvent).keyCode;
            if (
              composingRef.current ||
              e.nativeEvent.isComposing ||
              e.key === "Process" ||
              nativeKeyCode === 229
            ) {
              return;
            }
            // macOS WKWebView / Safari fires compositionend BEFORE the keydown of the
            // Enter/Escape/Backspace key that ended composition (WebKit #165004).
            // Swallow that trailing keydown so pressing Enter to confirm Pinyin never
            // submits the terminal prompt prematurely.
            if (
              (e.key === "Enter" || e.key === "Escape" || e.key === "Backspace") &&
              performance.now() - compositionEndAtRef.current < 60
            ) {
              e.preventDefault();
              return;
            }
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
              e.preventDefault();
              openSearchBar();
              return;
            }
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") {
              const sel = getSelectionText();
              if (sel) {
                e.preventDefault();
                void copyToClipboard(sel);
                return;
              }
            }
            const seq = keyEventToBytes(e, Boolean(frameRef.current?.app_cursor));
            if (seq !== null) {
              e.preventDefault();
              sendRawInput(seq);
            }
          }}
          onPaste={(e) => {
            const pastedFiles: File[] = [];
            if (e.clipboardData.files && e.clipboardData.files.length > 0) {
              pastedFiles.push(...Array.from(e.clipboardData.files));
            } else if (e.clipboardData.items) {
              for (const item of Array.from(e.clipboardData.items)) {
                if (item.kind === "file") {
                  const f = item.getAsFile();
                  if (f) pastedFiles.push(f);
                }
              }
            }
            if (pastedFiles.length > 0) {
              e.preventDefault();
              void uploadFiles(pastedFiles);
              return;
            }
            const text = e.clipboardData.getData("text");
            if (text) {
              e.preventDefault();
              const payload = frameRef.current?.bracketed_paste
                ? `\x1b[200~${text}\x1b[201~`
                : text;
              sendRawInput(payload);
            }
          }}
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: 1,
            height: 1,
            opacity: 0,
            pointerEvents: "none",
          }}
        />
        {searchOpen && (
          <div
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              position: "absolute",
              top: 8,
              right: 14,
              zIndex: 12,
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "5px 8px",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.16)",
              background: "rgba(22,23,27,0.96)",
              color: "#e4e4e7",
              fontSize: 12,
            }}
          >
            <input
              ref={searchInputRef}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || (e.nativeEvent as KeyboardEvent).keyCode === 229) {
                  return;
                }
                if (e.key === "Escape") {
                  closeSearchBar();
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  jumpToSearchMatch(searchMatches, searchIndex + (e.shiftKey ? -1 : 1));
                }
              }}
              placeholder="Find in scrollback…"
              style={{
                width: 170,
                background: "rgba(0,0,0,0.35)",
                color: "#e4e4e7",
                border: "1px solid rgba(255,255,255,0.14)",
                borderRadius: 5,
                padding: "3px 7px",
                fontSize: 12,
                outline: "none",
              }}
            />
            <span style={{ fontSize: 11, color: "rgba(228,228,231,0.65)", minWidth: 38, textAlign: "center" }}>
              {searchMatches.length > 0 ? `${searchIndex + 1}/${searchMatches.length}` : "0/0"}
            </span>
            <button
              type="button"
              onClick={() => jumpToSearchMatch(searchMatches, searchIndex - 1)}
              style={{ border: "none", background: "transparent", color: "#e4e4e7", cursor: "pointer", padding: "0 4px" }}
              title="Previous match"
            >
              ↑
            </button>
            <button
              type="button"
              onClick={() => jumpToSearchMatch(searchMatches, searchIndex + 1)}
              style={{ border: "none", background: "transparent", color: "#e4e4e7", cursor: "pointer", padding: "0 4px" }}
              title="Next match"
            >
              ↓
            </button>
            <button
              type="button"
              onClick={closeSearchBar}
              style={{ border: "none", background: "transparent", color: "rgba(228,228,231,0.7)", cursor: "pointer", padding: "0 4px" }}
              title="Close (Esc)"
            >
              ✕
            </button>
          </div>
        )}
        {ctxMenu && (
          <div
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              position: "fixed",
              left: ctxMenu.x,
              top: ctxMenu.y,
              zIndex: 80,
              minWidth: 150,
              padding: 4,
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.16)",
              background: "rgba(24,25,29,0.98)",
              boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
              display: "flex",
              flexDirection: "column",
              gap: 2,
              fontSize: 12.5,
              color: "#e4e4e7",
            }}
          >
            {[
              {
                label: "Copy",
                action: () => {
                  const sel = getSelectionText();
                  if (sel) void copyToClipboard(sel);
                },
              },
              {
                label: "Paste",
                action: () => {
                  void readClipboardText().then((txt) => {
                    if (!txt) return;
                    const payload = frameRef.current?.bracketed_paste
                      ? `\x1b[200~${txt}\x1b[201~`
                      : txt;
                    sendRawInput(payload);
                  });
                },
              },
              {
                label: "Find (⌘F)",
                action: () => openSearchBar(),
              },
              {
                label: "Clear Screen",
                action: () => sendRawInput("\x0c"),
              },
              {
                label: "Jump to Bottom",
                action: () => {
                  void enqueueTermOp(() =>
                    invoke<NativeTermFrame>("native_term_snap_bottom", { id: terminalId }),
                  )
                    .then((frame) => applyFrameRef.current(frame))
                    .catch(() => {});
                },
              },
            ].map((item) => (
              <button
                key={item.label}
                type="button"
                onClick={() => {
                  setCtxMenu(null);
                  item.action();
                }}
                style={{
                  border: "none",
                  background: "transparent",
                  color: "#e4e4e7",
                  textAlign: "left",
                  padding: "6px 10px",
                  borderRadius: 5,
                  cursor: "pointer",
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
        )}
        {uploadStatus && (
          <div
            style={{
              position: "absolute",
              left: 12,
              bottom: 10,
              padding: "4px 10px",
              borderRadius: 999,
              border: `1px solid ${uploadStatus.error ? "rgba(239,68,68,0.5)" : "rgba(255,255,255,0.18)"}`,
              background: "rgba(24,25,29,0.92)",
              color: uploadStatus.error ? "#fca5a5" : "#e4e4e7",
              fontSize: 11,
            }}
          >
            {uploadStatus.text}
            {uploadStatus.total && uploadStatus.total > 0 && uploadStatus.sent !== undefined
              ? ` (${Math.min(100, Math.round((uploadStatus.sent / uploadStatus.total) * 100))}%)`
              : ""}
          </div>
        )}
        {hasScrollback && (
          <div
            ref={scrollbarTrackRef}
            data-testid="native-terminal-scrollbar"
            onMouseEnter={() => {
              syncVisibleHistorySize();
              setScrollbarHover(true);
            }}
            onMouseLeave={() => setScrollbarHover(false)}
            onMouseDown={(e) => {
              e.stopPropagation();
              e.preventDefault();
              scrollbarDragRef.current = true;
              scrollToTrackClientY(e.clientY);
            }}
            style={{
              position: "absolute",
              top: 4,
              right: 2,
              bottom: 4,
              width: scrollbarHover || scrollbarDragRef.current ? 12 : 8,
              cursor: "pointer",
              opacity: showScrollbar ? 1 : 0,
              transition: "opacity 180ms ease, width 120ms ease",
              zIndex: 5,
            }}
          >
            <div
              style={{
                position: "absolute",
                left: 2,
                right: 2,
                top: `${thumbTopPct}%`,
                height: `${thumbHeightPct}%`,
                borderRadius: 999,
                background:
                  scrollbarHover || scrollbarDragRef.current
                    ? "rgba(255,255,255,0.48)"
                    : "rgba(255,255,255,0.28)",
              }}
            />
          </div>
        )}
        {!remoteOwnsScroll && scrollbackOffset > 0 && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void enqueueTermOp(() =>
                invoke<NativeTermFrame>("native_term_snap_bottom", { id: terminalId }),
              )
                .then((frame) => applyFrameRef.current(frame))
                .catch(() => {});
            }}
            style={{
              position: "absolute",
              right: 12,
              bottom: 10,
              padding: "4px 10px",
              borderRadius: 999,
              border: "1px solid rgba(255,255,255,0.18)",
              background: "rgba(24,25,29,0.92)",
              color: "#e4e4e7",
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            ↓ +{scrollbackOffset} lines
          </button>
        )}
        {copiedToast && (
          <div
            style={{
              position: "absolute",
              right: 12,
              bottom: scrollbackOffset > 0 ? 42 : 10,
              padding: "3px 9px",
              borderRadius: 999,
              border: "1px solid rgba(163,230,53,0.35)",
              background: "rgba(24,25,29,0.92)",
              color: "#d9f99d",
              fontSize: 11,
              pointerEvents: "none",
            }}
          >
            Copied
          </div>
        )}
      </div>
    );
  },
);
