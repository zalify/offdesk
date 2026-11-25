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
import type { SelectionSnapshot, TerminalViewProps, TerminalViewRef } from "./TerminalView.types";

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

/**
 * Zero-xterm.js terminal view backed by Rust `alacritty_terminal 0.25` (10,000-line scrollback)
 * over Tauri IPC, painted directly onto a Retina HiDPI hardware-accelerated Canvas.
 * Runs seamlessly inside the existing Tauri Desktop/Mobile UI with zero z-index or WebGL limits.
 */
export const TerminalView = forwardRef<TerminalViewRef, TerminalViewProps>(
  function NativeTerminalView(props, ref) {
    const {
      terminalId,
      wsUrl,
      cols: initialCols,
      rows: initialRows,
      canType = true,
      canResizeTerminal = true,
      onTitleChange,
      onReconnectingChange,
      onReady,
      inputTransformRef,
      style,
    } = props;

    const { theme } = useTerminalTheme();
    const containerRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const wsRef = useRef<WebSocket | null>(null);
    const frameRef = useRef<NativeTermFrame | null>(null);
    const dimsRef = useRef<{ cols: number; rows: number }>({
      cols: Math.max(20, initialCols || 120),
      rows: Math.max(6, initialRows || 36),
    });
    const metricsRef = useRef<{ cellW: number; cellH: number }>({ cellW: 8.4, cellH: 18 });
    const readyFiredRef = useRef(false);
    const composingRef = useRef(false);
    const [sessionGen, setSessionGen] = useState(0);
    const [fontPrefs, setFontPrefs] = useState(() => readTerminalFontPreferences());
    const [scrollbackOffset, setScrollbackOffset] = useState(0);
    const wheelAccumPxRef = useRef(0);
    const pendingScrollLinesRef = useRef(0);
    const scrollInFlightRef = useRef(false);
    const scrollRafRef = useRef<number | null>(null);
    const paintRafRef = useRef<number | null>(null);
    const lastScrollBadgeUpdateRef = useRef(0);

    // Selection state (grid cell coordinates)
    const selectionRef = useRef<{
      start: { col: number; row: number };
      end: { col: number; row: number };
    } | null>(null);
    const draggingRef = useRef(false);

    useEffect(() => subscribeFontPreferences(() => setFontPrefs(readTerminalFontPreferences())), []);

    const fontFamily = `${fontPrefs.fontFamily || DEFAULT_TERMINAL_FONT}, ${TERMINAL_SYMBOL_FONT}, monospace`;
    const fontSize = fontPrefs.fontSize || 14;
    const lineHeight = Math.round(fontSize * 1.32);

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
        ctx.font = `${fontSize}px ${fontFamily}`;
        const measuredW = ctx.measureText("MMMMMMMMMM").width / 10;
        const cellW = measuredW > 4 ? measuredW : fontSize * 0.6;
        const cellH = lineHeight;
        metricsRef.current = { cellW, cellH };

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

        // 3. Cursor
        if (frame.cursor) {
          const [cx, cy] = frame.cursor;
          ctx.fillStyle = cursorCol;
          ctx.globalAlpha = 0.85;
          ctx.fillRect(padX + cx * cellW, padY + cy * cellH, cellW, cellH);
          ctx.globalAlpha = 1;
        }

        // 4. Text spans (cache ctx.font & ctx.fillStyle to avoid WKWebView font re-parse jank)
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
            ctx.fillText(sp.t, padX + sp.c * cellW, y);
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
      },
      [],
    );

    const applyFrame = useCallback(
      (frame: NativeTermFrame) => {
        const prevOffset = frameRef.current?.display_offset ?? 0;
        frameRef.current = frame;
        const now = performance.now();
        if (
          (frame.display_offset === 0) !== (prevOffset === 0) ||
          now - lastScrollBadgeUpdateRef.current > 80
        ) {
          lastScrollBadgeUpdateRef.current = now;
          setScrollbackOffset(frame.display_offset);
        }
        if (frame.title && onTitleChange) {
          onTitleChange(frame.title);
        }
        schedulePaint();
        if (!readyFiredRef.current) {
          readyFiredRef.current = true;
          onReady?.();
        }
      },
      [schedulePaint, onTitleChange, onReady],
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

    const fitToContainer = useCallback(
      (opts?: { skipIfUnchanged?: boolean }) => {
        const container = containerRef.current;
        const canvas = canvasRef.current;
        if (!container || !canvas) return;
        const rect = container.getBoundingClientRect();
        if (rect.width < 40 || rect.height < 40) return;

        // Measure font cell accurately before computing cols/rows.
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.font = `${fontSize}px ${fontFamily}`;
          const mw = ctx.measureText("MMMMMMMMMM").width / 10;
          metricsRef.current = {
            cellW: mw > 4 ? mw : fontSize * 0.6,
            cellH: lineHeight,
          };
        }

        const { cellW, cellH } = metricsRef.current;
        const cols = Math.max(20, Math.floor((rect.width - 16) / cellW));
        const rows = Math.max(6, Math.floor((rect.height - 12) / cellH));
        const unchanged = dimsRef.current.cols === cols && dimsRef.current.rows === rows;
        dimsRef.current = { cols, rows };

        void invoke<NativeTermFrame>("native_term_resize", { id: terminalId, cols, rows })
          .then(applyFrame)
          .catch(() => {});

        if (canResizeTerminal && !(opts?.skipIfUnchanged && unchanged)) {
          const ws = wsRef.current;
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "resize", cols, rows }));
          }
        }
      },
      [fontSize, fontFamily, lineHeight, terminalId, canResizeTerminal, applyFrame],
    );

    // Open Rust alacritty_terminal instance on mount.
    useEffect(() => {
      readyFiredRef.current = false;
      void invoke<NativeTermFrame>("native_term_open", {
        id: terminalId,
        cols: dimsRef.current.cols,
        rows: dimsRef.current.rows,
      })
        .then(applyFrame)
        .catch(() => {});
      return () => {
        void invoke("native_term_close", { id: terminalId }).catch(() => {});
      };
    }, [terminalId]); // eslint-disable-line react-hooks/exhaustive-deps

    // Exact container ResizeObserver (zero setTimeout hacks!).
    useEffect(() => {
      const el = containerRef.current;
      if (!el) return;
      const ro = new ResizeObserver(() => fitToContainer({ skipIfUnchanged: true }));
      ro.observe(el);
      fitToContainer({ skipIfUnchanged: false });
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
        void invoke<NativeTermFrame>("native_term_feed", {
          id: terminalId,
          dataB64: bytesToBase64(batch),
        })
          .then((frame) => {
            if (!disposed) applyFrame(frame);
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
        onReconnectingChange?.(false);
        if (canResizeTerminal) {
          const { cols, rows } = dimsRef.current;
          ws.send(JSON.stringify({ type: "resize", cols, rows }));
        }
      };

      ws.onmessage = (event) => {
        if (disposed) return;
        if (typeof event.data === "string") {
          compression.handleText(event.data);
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
        onReconnectingChange?.(true);
        reconnect.scheduleReconnect();
      };
      ws.onerror = () => {
        if (disposed) return;
        onReconnectingChange?.(true);
      };

      return () => {
        disposed = true;
        if (rafId !== null) cancelAnimationFrame(rafId);
        reconnect.cancelReconnect();
        ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
        ws.close();
        if (wsRef.current === ws) wsRef.current = null;
      };
    }, [wsUrl, terminalId, sessionGen, canResizeTerminal, applyFrame, onReconnectingChange]);

    const copyToClipboard = useCallback(async (text: string) => {
      if (!text) return;
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
          return;
        }
      } catch {
        // Fall through to web clipboard API.
      }
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
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
      } catch {
        /* ignore */
      }
    }, []);

    const isWideChar = (cp: number): boolean =>
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
        (cp >= 0x20000 && cp <= 0x3fffd));

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
      const onWinMouseUp = () => {
        if (!draggingRef.current) return;
        draggingRef.current = false;
        const text = getSelectionText();
        if (text) {
          void copyToClipboard(text);
        }
      };
      window.addEventListener("mouseup", onWinMouseUp);
      return () => window.removeEventListener("mouseup", onWinMouseUp);
    }, [getSelectionText, copyToClipboard]);

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
        sendImageFile: async (file) => {
          const ws = await waitForWsOpen(() => wsRef.current, 5000);
          if (!ws) throw new Error("Terminal socket is not open");
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

    const pointerToCell = (clientX: number, clientY: number) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return { col: 0, row: 0 };
      const { cellW, cellH } = metricsRef.current;
      const col = Math.max(0, Math.floor((clientX - rect.left - 8) / cellW));
      const row = Math.max(0, Math.floor((clientY - rect.top - 6) / cellH));
      return {
        col: Math.min(col, dimsRef.current.cols),
        row: Math.min(row, Math.max(0, dimsRef.current.rows - 1)),
      };
    };

    return (
      <div
        ref={containerRef}
        data-testid="native-terminal-view"
        onMouseDown={(e) => {
          inputRef.current?.focus();
          if (e.button !== 0) return;
          const cell = pointerToCell(e.clientX, e.clientY);
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
        onMouseUp={() => {
          if (!draggingRef.current) return;
          draggingRef.current = false;
          const text = getSelectionText();
          if (text) {
            void copyToClipboard(text);
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
      </div>
    );
  },
);
