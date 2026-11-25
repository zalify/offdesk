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

function isWideChar(cp: number): boolean {
  return (
    cp >= 0x1100 &&
    (cp <= 0x115f ||
      cp === 0x2329 ||
      cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff) ||
      (cp >= 0x20000 && cp <= 0x3fffd))
  );
}

interface NativeSpan {
  c: number;
  t: string;
  f?: string;
  b?: boolean;
  i?: boolean;
}

interface NativeBgRun {
  r: number;
  c: number;
  l: number;
  g: string;
}

interface NativeTermFrame {
  cols: number;
  rows: number;
  spans: NativeSpan[][];
  bgs: NativeBgRun[];
  cursor: [number, number] | null;
  display_offset: number;
  history_size?: number;
  wants_mouse: boolean;
  bracketed_paste: boolean;
  title?: string;
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

function keyEventToBytes(e: React.KeyboardEvent<HTMLTextAreaElement>): string | null {
  if (e.nativeEvent.isComposing || e.key === "Process") return null;
  if (e.metaKey && !e.ctrlKey && !e.altKey) return null; // let macOS Cmd+C/V/K work

  if (e.ctrlKey && !e.altKey && e.key.length === 1) {
    const code = e.key.toUpperCase().charCodeAt(0);
    if (code >= 64 && code <= 95) {
      return String.fromCharCode(code - 64);
    }
  }

  switch (e.key) {
    case "Enter":
      return "\r";
    case "Backspace":
      return "\x7f";
    case "Tab":
      return e.shiftKey ? "\x1b[Z" : "\t";
    case "Escape":
      return "\x1b";
    case "ArrowUp":
      return "\x1b[A";
    case "ArrowDown":
      return "\x1b[B";
    case "ArrowRight":
      return "\x1b[C";
    case "ArrowLeft":
      return "\x1b[D";
    case "Home":
      return "\x1b[H";
    case "End":
      return "\x1b[F";
    case "PageUp":
      return "\x1b[5~";
    case "PageDown":
      return "\x1b[6~";
    case "Delete":
      return "\x1b[3~";
    default:
      if (e.altKey && e.key.length === 1) {
        return `\x1b${e.key}`;
      }
      return null;
  }
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
    const measureCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const metricsRef = useRef<{ cellW: number; cellH: number }>({ cellW: 8.4, cellH: 18 });
    const readyFiredRef = useRef(false);
    const composingRef = useRef(false);
    const [sessionGen, setSessionGen] = useState(0);
    const [fontPrefs, setFontPrefs] = useState(() => readTerminalFontPreferences());
    const [scrollbackOffset, setScrollbackOffset] = useState(0);
    const [historySize, setHistorySize] = useState(0);
    const [scrollbarVisible, setScrollbarVisible] = useState(false);
    const [scrollbarHover, setScrollbarHover] = useState(false);
    const maxObservedOffsetRef = useRef(0);
    const scrollbarFadeTimerRef = useRef<number | null>(null);
    const scrollbarTrackRef = useRef<HTMLDivElement | null>(null);
    const scrollbarDragRef = useRef(false);
    const wheelAccumPxRef = useRef(0);
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
    const [searchMatches, setSearchMatches] = useState<number[]>([]);
    const [searchIndex, setSearchIndex] = useState(0);
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

    // Selection state (grid cell coordinates)
    const selectionRef = useRef<{
      start: { col: number; row: number };
      end: { col: number; row: number };
    } | null>(null);
    const draggingRef = useRef(false);

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
        const rect = container.getBoundingClientRect();
        if (rect.width < 10 || rect.height < 10) return;

        const dpr = window.devicePixelRatio || 1;
        const targetW = Math.round(rect.width * dpr);
        const targetH = Math.round(rect.height * dpr);
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
        ctx.fillRect(0, 0, rect.width, rect.height);

        const padX = 8;
        const padY = 6;
        const { cellW, cellH } = measureCellMetrics();

        if (!frame) {
          ctx.restore();
          return;
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

        // 2. Selection highlight
        const sel = selectionRef.current;
        if (sel) {
          const [a, b] =
            sel.start.row < sel.end.row ||
            (sel.start.row === sel.end.row && sel.start.col <= sel.end.col)
              ? [sel.start, sel.end]
              : [sel.end, sel.start];
          ctx.fillStyle = "rgba(96, 165, 250, 0.32)";
          for (let r = a.row; r <= b.row; r++) {
            const c0 = r === a.row ? a.col : 0;
            const c1 = r === b.row ? b.col : frame.cols;
            if (c1 > c0) {
              ctx.fillRect(padX + c0 * cellW, padY + r * cellH, (c1 - c0) * cellW, cellH);
            }
          }
        }

        // 3. Cursor (+ anchor hidden IME textarea directly at cursor position)
        if (frame.cursor) {
          const [cx, cy] = frame.cursor;
          const cursorX = padX + cx * cellW;
          const cursorY = padY + cy * cellH;
          ctx.fillStyle = cursorCol;
          ctx.globalAlpha = 0.85;
          ctx.fillRect(cursorX, cursorY, cellW, cellH);
          ctx.globalAlpha = 1;
          const ta = inputRef.current;
          if (ta) {
            ta.style.left = `${Math.round(cursorX)}px`;
            ta.style.top = `${Math.round(cursorY)}px`;
            ta.style.height = `${Math.round(cellH)}px`;
            ta.style.fontSize = `${fontSize}px`;
            ta.style.lineHeight = `${cellH}px`;
          }
        }

        // 4. Text spans (cache ctx.font & ctx.fillStyle; align CJK/wide chars to exact cell grid)
        ctx.textBaseline = "top";
        let lastFont = `${fontSize}px ${fontFamily}`;
        ctx.font = lastFont;
        let lastFill = "";
        for (let r = 0; r < frame.spans.length; r++) {
          const spans = frame.spans[r];
          const y = padY + r * cellH + Math.floor((cellH - fontSize) * 0.5);
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
            if (/^[\x20-\x7e]*$/.test(sp.t)) {
              ctx.fillText(sp.t, padX + sp.c * cellW, y);
            } else {
              let col = sp.c;
              for (const ch of sp.t) {
                const cp = ch.codePointAt(0) ?? 0;
                const w = isWideChar(cp) ? 2 : 1;
                ctx.fillText(ch, padX + col * cellW, y);
                col += w;
              }
            }
          }
        }

        ctx.restore();
      },
      [theme, fontSize, fontFamily, lineHeight, measureCellMetrics],
    );

    const schedulePaint = useCallback(() => {
      if (paintRafRef.current !== null) return;
      paintRafRef.current = window.requestAnimationFrame(() => {
        paintRafRef.current = null;
        paintFrame(frameRef.current);
      });
    }, [paintFrame]);

    const pingScrollbar = useCallback(() => {
      setScrollbarVisible(true);
      if (scrollbarFadeTimerRef.current !== null) {
        window.clearTimeout(scrollbarFadeTimerRef.current);
      }
      scrollbarFadeTimerRef.current = window.setTimeout(() => {
        scrollbarFadeTimerRef.current = null;
        setScrollbarVisible(false);
      }, 1200);
    }, []);

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
      },
      [],
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
        rememberFrame(terminalId, frame);
        if (frame.display_offset > maxObservedOffsetRef.current) {
          maxObservedOffsetRef.current = frame.display_offset;
        }
        const effectiveHistory =
          typeof frame.history_size === "number"
            ? frame.history_size
            : maxObservedOffsetRef.current;
        const now = performance.now();
        if (
          frame.display_offset !== prevOffset ||
          (frame.display_offset === 0) !== (prevOffset === 0) ||
          now - lastScrollBadgeUpdateRef.current > 80
        ) {
          lastScrollBadgeUpdateRef.current = now;
          setScrollbackOffset(frame.display_offset);
          setHistorySize(effectiveHistory);
        }
        if (frame.display_offset !== prevOffset) {
          pingScrollbar();
        }
        if (frame.title && callbacksRef.current.onTitleChange) {
          callbacksRef.current.onTitleChange(frame.title);
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
      [terminalId, paintFrame, schedulePaint, pingScrollbar],
    );

    const flushPendingScroll = useCallback(() => {
      scrollRafRef.current = null;
      if (scrollInFlightRef.current) return;
      const deltaLines = pendingScrollLinesRef.current;
      if (deltaLines === 0) return;
      pendingScrollLinesRef.current = 0;
      scrollInFlightRef.current = true;
      void invoke<NativeTermFrame>("native_term_scroll", {
        id: terminalId,
        deltaLines,
      })
        .then((frame) => {
          applyFrame(frame);
        })
        .catch(() => {})
        .finally(() => {
          scrollInFlightRef.current = false;
          if (pendingScrollLinesRef.current !== 0 && scrollRafRef.current === null) {
            scrollRafRef.current = window.requestAnimationFrame(flushPendingScroll);
          }
        });
    }, [terminalId, applyFrame]);

    const sendRawInput = useCallback(
      (data: string) => {
        if (!canType || !data) return;
        const transformed = inputTransformRef?.current ? inputTransformRef.current(data) : data;
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          if ((frameRef.current?.display_offset ?? 0) > 0) {
            void invoke<NativeTermFrame>("native_term_snap_bottom", { id: terminalId })
              .then(applyFrame)
              .catch(() => {});
          }
          ws.send(JSON.stringify({ type: "input", data: transformed }));
        }
      },
      [canType, inputTransformRef, terminalId, applyFrame],
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
          .then(applyFrame)
          .catch(() => {});
      },
      [enqueueTermOp, terminalId, applyFrame],
    );

    const fitToContainer = useCallback(
      (opts?: { skipIfUnchanged?: boolean; immediate?: boolean }) => {
        const container = containerRef.current;
        if (!container) return;
        const rect = container.getBoundingClientRect();
        if (rect.width < 40 || rect.height < 40) return;

        const { cellW, cellH } = measureCellMetrics();
        const cols = Math.max(20, Math.floor((rect.width - 20) / cellW));
        const rows = Math.max(6, Math.floor((rect.height - 12) / cellH));
        const unchanged = dimsRef.current.cols === cols && dimsRef.current.rows === rows;
        dimsRef.current = { cols, rows };

        const sendResizeNow = () => {
          if (!callbacksRef.current.canResizeTerminal) return;
          const ws = wsRef.current;
          if (!ws || ws.readyState !== WebSocket.OPEN) return;
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
              }, 150);
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
          if (!cancelled) applyFrame(frame);
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
    }, [terminalId, applyFrame, enqueueTermOp]);

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
        paintFrame(frameRef.current);
      };
      void loadFonts();
      return () => {
        disposed = true;
      };
    }, [fontSize, fontFamily, measureCellMetrics, fitToContainer, paintFrame]);

    // Exact container ResizeObserver (zero setTimeout hacks!).
    useEffect(() => {
      const el = containerRef.current;
      if (!el) return;
      const ro = new ResizeObserver(() => fitToContainer({ skipIfUnchanged: true }));
      ro.observe(el);
      fitToContainer({ skipIfUnchanged: false, immediate: true });
      return () => ro.disconnect();
    }, [fitToContainer]);

    // Repaint when theme or font changes.
    useEffect(() => {
      paintFrame(frameRef.current);
    }, [paintFrame]);

    // Live WebSocket stream with deflate-raw-v1 decompression + rAF batching into Rust alacritty_terminal.
    useEffect(() => {
      if (!wsUrl) return;
      let disposed = false;
      const ws = openSocket(wsUrl);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      const compression = createDeflateRawV1Session({
        onError: () => {},
      });
      let pendingChunks: Uint8Array[] = [];
      let rafId: number | null = null;
      let inFlight = false;

      const flushToRust = () => {
        rafId = null;
        if (disposed || inFlight || pendingChunks.length === 0) return;
        const batch = concatChunks(pendingChunks);
        pendingChunks = [];
        inFlight = true;
        const isFirstLive = !hasLiveDataRef.current;
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
              applyFrame(frame, isFirstLive ? { sync: true } : undefined);
            }
          })
          .catch(() => {})
          .finally(() => {
            inFlight = false;
            if (!disposed && pendingChunks.length > 0 && rafId === null) {
              rafId = requestAnimationFrame(flushToRust);
            }
          });
      };

      const enqueueBytes = (bytes: Uint8Array) => {
        if (bytes.length === 0 || disposed) return;
        pendingChunks.push(bytes);
        // First live snapshot bypasses rAF so initial screen paints immediately (~32ms faster).
        if (!hasLiveDataRef.current && !inFlight) {
          if (rafId !== null) {
            cancelAnimationFrame(rafId);
            rafId = null;
          }
          flushToRust();
          return;
        }
        if (rafId === null) {
          rafId = requestAnimationFrame(flushToRust);
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

      ws.onopen = () => {
        if (disposed) return;
        reconnect.handleSocketOpen();
        callbacksRef.current.onReconnectingChange?.(false);
        lastSentResizeRef.current = null;
        fitToContainerRef.current({ skipIfUnchanged: false, immediate: true });
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
        callbacksRef.current.onReconnectingChange?.(true);
        reconnect.scheduleReconnect();
      };
      ws.onerror = () => {
        if (disposed) return;
        callbacksRef.current.onReconnectingChange?.(true);
      };

      return () => {
        disposed = true;
        if (rafId !== null) cancelAnimationFrame(rafId);
        reconnect.cancelReconnect();
        ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
        ws.close();
        if (wsRef.current === ws) wsRef.current = null;
      };
    }, [wsUrl, terminalId, sessionGen, applyFrame]);

    const [copiedToast, setCopiedToast] = useState(false);
    const copiedToastTimerRef = useRef<number | null>(null);

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

    const getSelectionText = useCallback((): string => {
      const sel = selectionRef.current;
      const frame = frameRef.current;
      if (!sel || !frame) return "";
      const [a, b] =
        sel.start.row < sel.end.row ||
        (sel.start.row === sel.end.row && sel.start.col <= sel.end.col)
          ? [sel.start, sel.end]
          : [sel.end, sel.start];
      if (a.row === b.row && a.col === b.col) return "";
      const lines: string[] = [];
      for (let r = a.row; r <= b.row; r++) {
        const rowSpans = frame.spans[r] ?? [];
        const chars = new Array<string>(frame.cols).fill(" ");
        for (const sp of rowSpans) {
          let col = sp.c;
          for (const ch of sp.t) {
            const cp = ch.codePointAt(0) ?? 0;
            const w = isWideChar(cp) ? 2 : 1;
            if (col < frame.cols) chars[col] = ch;
            if (w === 2 && col + 1 < frame.cols) chars[col + 1] = "";
            col += w;
          }
        }
        const c0 = r === a.row ? a.col : 0;
        const c1 = r === b.row ? b.col : frame.cols;
        lines.push(chars.slice(c0, c1).join("").trimEnd());
      }
      return lines.join("\n").trimEnd();
    }, []);

    useEffect(() => {
      const onWinMouseMove = (e: MouseEvent) => {
        if (!draggingRef.current || !selectionRef.current) return;
        selectionRef.current = {
          ...selectionRef.current,
          end: pointerToCell(e.clientX, e.clientY),
        };
        paintFrame(frameRef.current);
      };
      const onWinMouseUp = () => {
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
        window.removeEventListener("mousemove", onWinMouseMove);
        window.removeEventListener("mouseup", onWinMouseUp);
        document.removeEventListener("copy", onDocCopy);
      };
    }, [getSelectionText, copyToClipboard, paintFrame]);

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
          void invoke<NativeTermFrame>("native_term_snap_bottom", { id: terminalId })
            .then(applyFrame)
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
        const isTokenChar = (ch: string) => ch !== "" && !/\s|['"()[\]{}<>,;`]/.test(ch);
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
        const token = cells.slice(start, end).join("").replace(/[.:]+$/, "");
        if (!token) return null;
        return { token, startCol: start, endCol: end };
      },
      [],
    );

    const openSearchBar = useCallback(() => {
      setSearchOpen(true);
      void invoke<string[]>("native_term_plain_lines", { id: terminalId })
        .then((lines) => {
          plainLinesRef.current = lines;
        })
        .catch(() => {});
      window.setTimeout(() => searchInputRef.current?.focus(), 0);
    }, [terminalId]);

    const jumpToSearchMatch = useCallback(
      (matches: number[], idx: number) => {
        if (matches.length === 0) return;
        const wrapped = ((idx % matches.length) + matches.length) % matches.length;
        setSearchIndex(wrapped);
        const total = plainLinesRef.current.length;
        const lineIdx = matches[wrapped];
        const rows = frameRef.current?.rows ?? dimsRef.current.rows;
        const curOff = frameRef.current?.display_offset ?? 0;
        const targetOff = Math.max(0, total - lineIdx - Math.ceil(rows / 2));
        const deltaLines = targetOff - curOff;
        if (deltaLines !== 0) {
          void invoke<NativeTermFrame>("native_term_scroll", { id: terminalId, deltaLines })
            .then(applyFrame)
            .catch(() => {});
        }
      },
      [terminalId, applyFrame],
    );

    useEffect(() => {
      if (!searchOpen) return;
      const q = searchQuery.trim().toLowerCase();
      if (!q) {
        setSearchMatches([]);
        setSearchIndex(0);
        return;
      }
      const lines = plainLinesRef.current;
      const found: number[] = [];
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].toLowerCase().includes(q)) found.push(i);
      }
      setSearchMatches(found);
      if (found.length > 0) jumpToSearchMatch(found, 0);
    }, [searchOpen, searchQuery, jumpToSearchMatch]);

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
      const row = Math.max(0, Math.floor((clientY - rect.top - 6) / cellH));
      return {
        col: Math.min(col, maxCols),
        row: Math.min(row, Math.max(0, maxRows - 1)),
      };
    };

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
    const totalLines = Math.max(visibleRows, visibleRows + historySize);
    const hasScrollback = historySize > 0 || scrollbackOffset > 0;
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
          const cell = pointerToCell(e.clientX, e.clientY);
          if (e.detail === 2) {
            const tok = tokenAtCell(cell.col, cell.row);
            if (tok) {
              selectionRef.current = {
                start: { col: tok.startCol, row: cell.row },
                end: { col: tok.endCol, row: cell.row },
              };
              draggingRef.current = false;
              paintFrame(frameRef.current);
              void copyToClipboard(tok.token);
              return;
            }
          }
          if (e.detail >= 3) {
            const lineText = rowToPlainString(cell.row).trimEnd();
            selectionRef.current = {
              start: { col: 0, row: cell.row },
              end: { col: dimsRef.current.cols, row: cell.row },
            };
            draggingRef.current = false;
            paintFrame(frameRef.current);
            if (lineText) void copyToClipboard(lineText);
            return;
          }
          selectionRef.current = { start: cell, end: cell };
          draggingRef.current = true;
          paintFrame(frameRef.current);
        }}
        onMouseMove={(e) => {
          if (!draggingRef.current || !selectionRef.current) return;
          selectionRef.current = {
            ...selectionRef.current,
            end: pointerToCell(e.clientX, e.clientY),
          };
          paintFrame(frameRef.current);
        }}
        onMouseUp={(e) => {
          if (!draggingRef.current) return;
          draggingRef.current = false;
          const text = getSelectionText();
          if (text) {
            void copyToClipboard(text);
            return;
          }
          if (e.metaKey || e.ctrlKey) {
            const cell = pointerToCell(e.clientX, e.clientY);
            const tok = tokenAtCell(cell.col, cell.row);
            if (tok) {
              if (/^https?:\/\//i.test(tok.token)) {
                openExternalUrl(tok.token);
                return;
              }
              const cleaned = tok.token.replace(/^file:\/\//i, "").replace(/:\d+(?::\d+)?$/, "");
              if (
                onOpenDirectory &&
                machineId &&
                (cleaned.includes("/") || /\.[a-z0-9]{1,8}$/i.test(cleaned))
              ) {
                const resolved = resolveRemotePath(cleaned, cwd) ?? cleaned;
                onOpenDirectory(machineId, resolved);
              }
            }
          }
        }}
        onWheel={(e) => {
          e.preventDefault();
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

          if (frameRef.current?.wants_mouse) {
            const btn = lines > 0 ? 64 : 65;
            const count = Math.min(5, Math.max(1, Math.abs(lines)));
            const cell = pointerToCell(e.clientX, e.clientY);
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
        style={{
          position: "relative",
          flex: 1,
          width: "100%",
          height: "100%",
          minHeight: 0,
          overflow: "hidden",
          cursor: "text",
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
        <textarea
          ref={inputRef}
          aria-label="Terminal input"
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={(e) => {
            composingRef.current = false;
            const text = e.data;
            if (text) sendRawInput(text);
            e.currentTarget.value = "";
          }}
          onInput={(e) => {
            if (composingRef.current) return;
            const text = e.currentTarget.value;
            if (text) {
              sendRawInput(text);
              e.currentTarget.value = "";
            }
          }}
          onKeyDown={(e) => {
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
            const seq = keyEventToBytes(e);
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
                if (e.key === "Escape") {
                  setSearchOpen(false);
                  inputRef.current?.focus();
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
              onClick={() => {
                setSearchOpen(false);
                inputRef.current?.focus();
              }}
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
                  void invoke<NativeTermFrame>("native_term_snap_bottom", { id: terminalId })
                    .then(applyFrame)
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
            onMouseEnter={() => setScrollbarHover(true)}
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
        {scrollbackOffset > 0 && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void invoke<NativeTermFrame>("native_term_snap_bottom", { id: terminalId })
                .then(applyFrame)
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
