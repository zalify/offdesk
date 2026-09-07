import { createComposerTransport } from "@/lib/composerTransport";
import {
  useEffect,
  useRef,
  useCallback,
  useImperativeHandle,
  forwardRef,
  useState,
} from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

import type { TerminalViewRef, TerminalViewProps } from "./TerminalView.types";
import { measureTerminalSurface, readXtermCellMetrics } from "./terminalXtermMetrics";
import { useTerminalFitController } from "./useTerminalFitController";
import { useTerminalLiveSocket } from "./useTerminalLiveSocket";
import { terminalTheme } from "@/lib/colors";
import {
  shouldSendClipboardImagePaste,
  type ImagePasteDedupeRecord,
} from "@/lib/imagePasteDedupe";
import {
  buildImagePasteMessage,
  MAX_IMAGE_PASTE_BYTES,
  readFileAsBase64,
  safeFilename,
  waitForWsOpen,
} from "@/lib/terminalImagePaste";
import {
  mergeWrappedRows,
  trimTrailingBlankLines,
  type RawRow,
} from "@/lib/terminalSelection";
import { createSelectionAutoCopyController } from "@/lib/selectionAutoCopy";
import { createTerminalClipboardProvider } from "@/lib/terminalClipboard";
import { isTauri } from "@/lib/platform";
import { bulkKeypressText } from "@/lib/terminalBulkKey";
import { attachIosTerminalInput } from "@/lib/iosTerminalInput";
import { readClipboardText } from "@/lib/readClipboardText";
import { createExternalUrlOpener } from "@/lib/terminalLinks";
import { useDisplayMode } from "@/lib/hooks";
import { usePrefixKey } from "@/lib/prefixKeyContext";
import { filterBrowserGeneratedTerminalInput } from "@/lib/terminalInputFilter";
import {
  createInputBatcher,
  type InputBatcher,
} from "@/lib/terminalInputBatcher";
import { createWheelDirectionGate } from "@/lib/terminalWheelGate";
import { activateGpuRenderer } from "@/lib/terminalGpuRenderer";
import { readTerminalFontPreferences, subscribeFontPreferences } from "@/lib/fontPreferences";

const TERM_COLS = 120;
const TERM_ROWS = 36;
// Chosen so one cell-height of trackpad/finger travel emits ~one wheel
// report: xterm's pixel-delta path divides by cell height and dampens
// likely-trackpad deltas by 0.3, so sensitivity 3 lands at ~1 report/line.
// tmux's copy-mode bindings scroll 1 line per report (machine tmux.conf
// overrides tmux's 5-line default), giving finger-true scrolling. The old
// value of 6 (picked when tmux still jumped 5 lines/report) overshot 2x.
const TERMINAL_SCROLL_SENSITIVITY = 3;

// Invoke a Tauri command through the internals global rather than
// dynamic-importing the plugin's JS package. Metro turns
// `import("@tauri-apps/...")` into a chunk-loaded async require, which has
// been observed to resolve without reaching the native side (see the
// clipboard-manager note in clipboardWrite below) — a link tap then looks
// like it succeeded while nothing opens.
function invokeTauri(
  cmd: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const internals = (window as unknown as {
    __TAURI_INTERNALS__?: {
      invoke: <T = unknown>(
        cmd: string,
        args?: Record<string, unknown>,
      ) => Promise<T>;
    };
  }).__TAURI_INTERNALS__;
  if (!internals?.invoke) {
    return Promise.reject(new Error("__TAURI_INTERNALS__ not available"));
  }
  return internals.invoke(cmd, args);
}

const openExternalUrlInner = createExternalUrlOpener({
  isTauri,
  // tauri-plugin-opener: Intent.ACTION_VIEW on Android, system default
  // browser on desktop.
  tauriOpenUrl: (url) => invokeTauri("plugin:opener|open_url", { url }),
  // Older installed shells predate the opener plugin; plugin-shell's open
  // still works there (desktop only — it spawns a system opener process).
  tauriShellOpen: (url) => invokeTauri("plugin:shell|open", { path: url }),
  windowOpen: (url) => {
    window.open(url, "_blank", "noopener,noreferrer");
  },
  // Android WebViews advertise a `wv` UA token and ignore `window.open`
  // unless the host app implements onCreateWindow — which this shell does
  // not. Anywhere else (real browsers) it is the normal, working path.
  canTrustWindowOpen: () =>
    typeof navigator === "undefined" || !/\bwv\b/.test(navigator.userAgent),
  onOutcome: (outcome) => {
    if (outcome.channel) return;
    // Nothing opened the link. Mobile users have no console, so surface it —
    // tapping the toast copies the URL so the tap is not simply lost.
    showLinkDiagnostic(outcome.url, outcome.errors);
  },
});

let lastLinkOpen: { url: string; at: number } | null = null;
function openExternalUrl(url: string): void {
  // A single tap can reach here twice: through the touchend tap-activation
  // path below AND through the Linkifier when the browser also synthesizes
  // compat mouse events (desktop emulation does, Android WebView does not).
  // Collapse duplicates instead of opening the URL twice.
  const now = Date.now();
  if (lastLinkOpen && lastLinkOpen.url === url && now - lastLinkOpen.at < 600) {
    return;
  }
  lastLinkOpen = { url, at: now };
  openExternalUrlInner(url);
}

interface XtermMouseService {
  getCoords: (
    event: { clientX: number; clientY: number },
    element: HTMLElement,
    colCount: number,
    rowCount: number,
    isSelection?: boolean,
  ) => [number, number] | undefined;
  getMouseReportCoords: (
    event: MouseEvent,
    element: HTMLElement,
  ) => { col: number; row: number; x: number; y: number } | undefined;
}

type TerminalWithMouseService = Terminal & {
  _core?: {
    // 6.1 split coordinate math out of MouseService; keep the old field as
    // a fallback so the patch survives either layout.
    _mouseCoordsService?: XtermMouseService;
    _mouseService?: XtermMouseService;
  };
};

function getLayoutMouseEvent<T extends { clientX: number; clientY: number }>(
  event: T,
  element: HTMLElement,
): T | { clientX: number; clientY: number } {
  const rect = element.getBoundingClientRect();
  const layoutWidth = element.clientWidth || element.offsetWidth;
  const layoutHeight = element.clientHeight || element.offsetHeight;
  const scaleX = layoutWidth > 0 ? rect.width / layoutWidth : 1;
  const scaleY = layoutHeight > 0 ? rect.height / layoutHeight : 1;
  const hasScaledX = Number.isFinite(scaleX) && Math.abs(scaleX - 1) > 0.001;
  const hasScaledY = Number.isFinite(scaleY) && Math.abs(scaleY - 1) > 0.001;

  if (!hasScaledX && !hasScaledY) return event;

  return {
    clientX: hasScaledX
      ? rect.left + (event.clientX - rect.left) / scaleX
      : event.clientX,
    clientY: hasScaledY
      ? rect.top + (event.clientY - rect.top) / scaleY
      : event.clientY,
  };
}

function patchScaledMouseCoordinates(term: Terminal): () => void {
  // xterm calculates mouse cells from untransformed renderer metrics. Adjust
  // pointer coordinates when an ancestor visually scales the terminal.
  const core = (term as TerminalWithMouseService)._core;
  const mouseService = [core?._mouseCoordsService, core?._mouseService].find(
    (service) =>
      typeof service?.getCoords === "function" &&
      typeof service.getMouseReportCoords === "function",
  );
  if (!mouseService) return () => {};

  const originalGetCoords = mouseService.getCoords.bind(mouseService);
  const originalGetMouseReportCoords =
    mouseService.getMouseReportCoords.bind(mouseService);

  mouseService.getCoords = (
    event,
    element,
    colCount,
    rowCount,
    isSelection,
  ) =>
    originalGetCoords(
      getLayoutMouseEvent(event, element),
      element,
      colCount,
      rowCount,
      isSelection,
    );

  mouseService.getMouseReportCoords = (event, element) =>
    originalGetMouseReportCoords(
      getLayoutMouseEvent(event, element) as MouseEvent,
      element,
    );

  return () => {
    mouseService.getCoords = originalGetCoords;
    mouseService.getMouseReportCoords = originalGetMouseReportCoords;
  };
}

interface XtermCompositionHelper {
  _isComposing: boolean;
  _compositionPosition: { start: number; end: number };
  _compositionSuffix: string;
  _isSendingComposition: boolean;
  _dataAlreadySent: string;
  _textareaChangeTimer?: number;
  _textarea: HTMLTextAreaElement;
  _compositionView: HTMLElement;
  _coreService: { triggerDataEvent(data: string, wasUserInput?: boolean): void };
  compositionstart(): void;
  _finalizeComposition(waitForPropagation: boolean): void;
  _handleAnyTextareaChanges(): void;
}

type TerminalWithCompositionHelper = Terminal & {
  _core?: { _compositionHelper?: XtermCompositionHelper; _keyPressHandled?: boolean; _keyDownHandled?: boolean };
};

function patchCompositionHelperSendRace(term: Terminal): () => void {
  // xterm's CompositionHelper finalizes a composition with a setTimeout(0)
  // that computes the text to send from LIVE textarea state at run time:
  // the region end comes from the newest composition's live position (or
  // live value.length), the #3191 dedup offset from live _dataAlreadySent,
  // and cancellation is one shared _isSendingComposition boolean that every
  // compositionend re-arms. On a starved main thread (slow phones, CI) the
  // 0ms timers queue behind input tasks; a stale timer then fires with an
  // over-wide region covering later commits, and the timers that owned
  // those commits are cancelled — the same commit reaches onData twice
  // (upstream xterm.js#5023, unfixed as of 6.1.0-beta.303).
  //
  // Workaround: track how much of the textarea prefix has already been
  // emitted (`emittedPrefixLength`) and clamp every deferred send region to
  // start at or after it. Content is never compared, so legitimate repeated
  // text (测测) still flows; each textarea position is simply emitted at
  // most once. The watermark is resynced when the textarea is cleared
  // (blur / Enter clears value, detected at the next compositionstart).
  const helper = (term as TerminalWithCompositionHelper)._core
    ?._compositionHelper;
  if (
    !helper ||
    typeof helper._finalizeComposition !== "function" ||
    typeof helper._handleAnyTextareaChanges !== "function" ||
    !helper._textarea
  ) {
    return () => {};
  }

  let emittedPrefixLength = 0;

  const originalCompositionStart = helper.compositionstart.bind(helper);
  const originalFinalize = helper._finalizeComposition.bind(helper);
  const originalHandleAnyTextareaChanges =
    helper._handleAnyTextareaChanges.bind(helper);

  helper.compositionstart = () => {
    originalCompositionStart();
    if (helper._textarea.value.length < emittedPrefixLength) {
      emittedPrefixLength = helper._compositionPosition.start;
    }
  };

  helper._finalizeComposition = (waitForPropagation: boolean): void => {
    helper._compositionView.classList.remove("active");
    helper._isComposing = false;

    if (!waitForPropagation) {
      // Cancel any delayed composition send requests and send the input
      // immediately (upstream verbatim, plus watermark advance).
      helper._isSendingComposition = false;
      const input = helper._textarea.value.substring(
        helper._compositionPosition.start,
        helper._compositionPosition.end,
      );
      emittedPrefixLength = Math.max(
        emittedPrefixLength,
        helper._compositionPosition.start + input.length,
      );
      helper._coreService.triggerDataEvent(input, true);
      return;
    }

    const currentCompositionPosition = {
      start: helper._compositionPosition.start,
      end: helper._compositionPosition.end,
    };
    const currentCompositionSuffix = helper._compositionSuffix;

    helper._isSendingComposition = true;
    setTimeout(() => {
      if (!helper._isSendingComposition) {
        return;
      }
      helper._isSendingComposition = false;
      // Upstream #3191 guard, then the watermark clamp: never re-emit a
      // textarea prefix any sender (this timer, the 229 diff timer, or the
      // sync finalize) has already accounted for — even if a newer
      // compositionstart reset _dataAlreadySent in between.
      const start = Math.max(
        currentCompositionPosition.start + helper._dataAlreadySent.length,
        emittedPrefixLength,
      );
      let input: string;
      if (helper._isComposing) {
        // Use the start position of the new composition to get the string
        // if a new composition has started. Math.max guards against
        // substring's argument-swap when the watermark is past it.
        input = helper._textarea.value.substring(
          start,
          Math.max(start, helper._compositionPosition.start),
        );
      } else {
        const value = helper._textarea.value;
        const valueEnd =
          currentCompositionSuffix.length > 0 &&
          value.endsWith(currentCompositionSuffix)
            ? value.length - currentCompositionSuffix.length
            : value.length;
        input = value.substring(start, Math.max(start, valueEnd));
      }
      if (input.length > 0) {
        emittedPrefixLength = start + input.length;
        helper._coreService.triggerDataEvent(input, true);
      }
    }, 0);
  };

  helper._handleAnyTextareaChanges = (): void => {
    if (helper._textareaChangeTimer) {
      return;
    }
    const oldValue = helper._textarea.value;
    helper._textareaChangeTimer = window.setTimeout(() => {
      helper._textareaChangeTimer = undefined;
      // Ignore if a composition has started since the timeout
      if (helper._isComposing) {
        return;
      }
      const newValue = helper._textarea.value;
      if (newValue.length > oldValue.length) {
        // IMEs append at the caret; skip any prefix a composition finalize
        // already emitted while this timer was starved.
        const input = newValue.substring(
          Math.max(emittedPrefixLength, oldValue.length),
        );
        helper._dataAlreadySent = input;
        if (input.length > 0) {
          helper._coreService.triggerDataEvent(input, true);
        }
      } else if (newValue.length < oldValue.length) {
        helper._dataAlreadySent = newValue.replace(oldValue, "");
        // C0.DEL, matching upstream's shrink branch.
        helper._coreService.triggerDataEvent("\x7f", true);
      } else if (newValue !== oldValue) {
        helper._dataAlreadySent = newValue;
        helper._coreService.triggerDataEvent(newValue, true);
      } else {
        return;
      }
      // Whatever is now in the textarea has been accounted for.
      emittedPrefixLength = newValue.length;
    }, 0);
  };

  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const core = (term as TerminalWithCompositionHelper)._core;
  const removeIosInput = ios ? attachIosTerminalInput({
    textarea: helper._textarea,
    composing: () => helper._isComposing || helper._isSendingComposition,
    keyHandled: () => !!core?._keyPressHandled || !!core?._keyDownHandled,
    disabled: () => !!term.options.screenReaderMode,
    commit: (text) => {
      if (helper._textareaChangeTimer !== undefined) window.clearTimeout(helper._textareaChangeTimer);
      helper._textareaChangeTimer = undefined;
      helper._dataAlreadySent = "";
      emittedPrefixLength = helper._textarea.value.length;
      if (text) helper._coreService.triggerDataEvent(text, true);
    },
  }) : () => {};

  return () => {
    removeIosInput();
    helper.compositionstart = originalCompositionStart;
    helper._finalizeComposition = originalFinalize;
    helper._handleAnyTextareaChanges = originalHandleAnyTextareaChanges;
  };
}

function formatErr(err: unknown): string {
  if (err == null) return "unknown";
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message || err.toString();
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

// Surface a failed link open the same way: mobile shells have no devtools,
// and a tap that silently does nothing is indistinguishable from a tap that
// was never registered. Tapping the toast copies the URL.
function showLinkDiagnostic(url: string, errors: string[]): void {
  if (typeof document === "undefined") return;
  const id = "offdesk-link-diagnostic";
  document.getElementById(id)?.remove();
  const div = document.createElement("div");
  div.id = id;
  div.style.cssText =
    "position:fixed;top:8px;left:8px;right:8px;background:rgba(220,40,40,0.95);" +
    "color:#fff;padding:8px 12px;z-index:99999;font:12px/1.4 monospace;" +
    "border-radius:6px;word-break:break-all;" +
    "box-shadow:0 2px 8px rgba(0,0,0,0.4);pointer-events:auto;cursor:pointer;";
  const reason = errors.length > 0 ? errors.join(" | ") : "no handler";
  div.textContent = `couldn't open link (${reason}) — tap to copy\n${url}`;
  div.style.whiteSpace = "pre-wrap";
  div.addEventListener("click", () => {
    void navigator.clipboard?.writeText(url).catch(() => {});
    div.remove();
  });
  document.body.appendChild(div);
  window.setTimeout(() => div.remove(), 10000);
}

// Surface a clipboard failure as a floating toast for users who can't open
// devtools (production Tauri builds). Auto-removes after 8 seconds.
function showCopyDiagnostic(message: string): void {
  if (typeof document === "undefined") return;
  const id = "offdesk-copy-diagnostic";
  const existing = document.getElementById(id);
  existing?.remove();
  const div = document.createElement("div");
  div.id = id;
  div.style.cssText =
    "position:fixed;top:8px;right:8px;background:rgba(220,40,40,0.95);" +
    "color:#fff;padding:8px 12px;z-index:99999;font:12px/1.4 monospace;" +
    "border-radius:6px;max-width:60vw;word-break:break-word;" +
    "box-shadow:0 2px 8px rgba(0,0,0,0.4);pointer-events:auto;cursor:pointer;";
  div.textContent = `copy failed — ${message}`;
  div.addEventListener("click", () => div.remove());
  document.body.appendChild(div);
  window.setTimeout(() => div.remove(), 8000);
}

export type { TerminalViewRef, TerminalViewProps };

export const TerminalView = forwardRef<TerminalViewRef, TerminalViewProps>(
  function TerminalView({
    machineId,
    terminalId,
    wsUrl,
    cols,
    rows,
    displayMode = "immersive",
    isController,
    canType,
    directInputEnabled = true,
    canResizeTerminal,
    onTitleChange,
    onReconnectingChange,
    inputTransformRef,
    style,
  }, ref) {
    const viewportRef = useRef<HTMLDivElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const termRef = useRef<Terminal | null>(null);
    const wsRef = useRef<WebSocket | null>(null);
    const [composerTransport] = useState(() => createComposerTransport(() => wsRef.current));
    const fitRef = useRef<FitAddon | null>(null);
    const isControllerRef = useRef(isController ?? true);
    const canTypeRef = useRef(canType ?? isController ?? true);
    const directInputRef = useRef(directInputEnabled);
    useEffect(() => {
      directInputRef.current = directInputEnabled;
      if (termRef.current) termRef.current.options.disableStdin = !directInputEnabled;
    }, [directInputEnabled]);
    const canResizeTerminalRef = useRef(canResizeTerminal ?? false);
    const measureRafRef = useRef<number | null>(null);
    const recentClipboardImagePasteRef =
      useRef<ImagePasteDedupeRecord | null>(null);
    const inputBatcherRef = useRef<InputBatcher | null>(null);
    // Stamped with the send time of each input batch when the echo-latency
    // probe is enabled (localStorage offdesk:echo-probe=1); the live socket
    // turns the first output after it into a round-trip sample.
    const echoProbeSentAtRef = useRef<number | null>(null);
    const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
    const [surfaceSize, setSurfaceSize] = useState({ width: 0, height: 0 });
    const [sessionGeneration, setSessionGeneration] = useState(0);
    const viewportSizeRef = useRef(viewportSize);

    // Prefix engine access for the xterm key handler below. The handler is
    // attached once at mount, so the latest values go through a ref.
    const prefixKey = usePrefixKey();
    const { isCompact } = useDisplayMode();
    const prefixKeyRef = useRef({ prefixKey, isCompact });
    useEffect(() => {
      prefixKeyRef.current = { prefixKey, isCompact };
    }, [prefixKey, isCompact]);

    useEffect(() => {
      isControllerRef.current = isController ?? true;
    }, [isController]);

    useEffect(() => {
      canTypeRef.current = canType ?? isController ?? true;
    }, [canType, isController]);

    useEffect(() => {
      canResizeTerminalRef.current = canResizeTerminal ?? false;
    }, [canResizeTerminal]);

    const measureLayout = useCallback(() => {
      const viewport = viewportRef.current;
      const container = containerRef.current;
      if (!viewport || !container) return;

      const nextViewportSize = {
        width: viewport.clientWidth,
        height: viewport.clientHeight,
      };
      const nextSurfaceSize = measureTerminalSurface(container);

      setViewportSize((current) =>
        current.width === nextViewportSize.width &&
        current.height === nextViewportSize.height
          ? current
          : nextViewportSize,
      );
      setSurfaceSize((current) =>
        current.width === nextSurfaceSize.width &&
        current.height === nextSurfaceSize.height
          ? current
          : nextSurfaceSize,
      );
      viewportSizeRef.current = nextViewportSize;
    }, []);

    const scheduleMeasure = useCallback(() => {
      if (measureRafRef.current) {
        cancelAnimationFrame(measureRafRef.current);
      }
      measureRafRef.current = requestAnimationFrame(() => {
        measureRafRef.current = null;
        measureLayout();
      });
    }, [measureLayout]);

    const clipboardWrite = useCallback(async (text: string) => {
      let tauriError: unknown = null;
      if (isTauri()) {
        // Use __TAURI_INTERNALS__.invoke directly instead of dynamic-importing
        // the plugin module. Metro compiles `await import("@tauri-apps/...")`
        // into a chunk-loaded async require; that path has been observed to
        // succeed for some plugins (updater, shell) but fail silently for
        // clipboard-manager on macOS WKWebView, leaving the OS clipboard
        // untouched. The internals global is injected by Tauri at
        // window-create time and is always present, so this avoids the
        // chunk-loading variable entirely.
        const internals = (window as unknown as {
          __TAURI_INTERNALS__?: {
            invoke: <T = unknown>(
              cmd: string,
              args?: Record<string, unknown>,
            ) => Promise<T>;
          };
        }).__TAURI_INTERNALS__;
        if (internals?.invoke) {
          try {
            await internals.invoke("plugin:clipboard-manager|write_text", {
              text,
            });
            return;
          } catch (err) {
            tauriError = err;
            // eslint-disable-next-line no-console
            console.warn("[offdesk] tauri clipboard invoke failed", err);
          }
        } else {
          showCopyDiagnostic("__TAURI_INTERNALS__ not available");
        }
      }
      try {
        await navigator.clipboard.writeText(text);
      } catch (err) {
        const prefix = tauriError
          ? `Tauri clipboard failed: ${formatErr(tauriError)}; browser clipboard failed`
          : "Browser clipboard failed";
        showCopyDiagnostic(`${prefix}: ${formatErr(err)}`);
        // eslint-disable-next-line no-console
        console.warn("[offdesk] navigator.clipboard.writeText failed", err);
        throw err;
      }
    }, []);

    const clipboardRead = readClipboardText;

    // Forward a picked file (mobile attach button, drag-drop, etc.) over
    // the live WS using the same `image_paste` protocol that clipboard
    // pastes use. Throws on failure so the caller can surface a message —
    // mobile users can't see console.warn.
    const sendImageFile = useCallback(
      async (file: Blob & { name?: string }): Promise<void> => {
        if (!canTypeRef.current) {
          throw new Error("Unlock view only to attach a file.");
        }
        if (file.size > MAX_IMAGE_PASTE_BYTES) {
          const mb = Math.round(MAX_IMAGE_PASTE_BYTES / (1024 * 1024));
          throw new Error(`File too large (max ${mb} MB).`);
        }
        // Mobile browsers commonly close the WebSocket while a file picker
        // sits in the foreground. Wait for the reconnect to land before
        // giving up so the user doesn't think the upload silently failed.
        const ws = await waitForWsOpen(() => wsRef.current, 5000);
        if (!ws) {
          throw new Error("Connection unavailable. Try again.");
        }
        const { base64, mime } = await readFileAsBase64(file);
        const ext = mime.includes("/") ? `.${mime.split("/")[1]}` : "";
        const filename = safeFilename(file.name ?? "", ext);
        inputBatcherRef.current?.flush();
        ws.send(JSON.stringify(buildImagePasteMessage(base64, mime, filename)));
      },
      [],
    );

    // Toggle DEC mouse-tracking modes locally so touch users can drag-select
    // text while in "select mode". We only flip the locally-written modes;
    // a TUI program can still re-enable on its own output, but for shells
    // and Claude Code / Codex sessions this is sufficient in practice.
    const setMouseTrackingEnabled = useCallback((enabled: boolean) => {
      const term = termRef.current;
      if (!term) return;
      term.write(enabled ? "\x1b[?1003h\x1b[?1006h" : "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l");
    }, []);

    const getSelection = useCallback((): string => {
      return termRef.current?.getSelection() ?? "";
    }, []);

    const getSelectionSnapshot = useCallback(() => {
      const term = termRef.current;
      if (!term) return null;
      const buf = term.buffer.active;
      const start = buf.viewportY;
      const rawRows: RawRow[] = [];
      for (let i = 0; i < term.rows; i++) {
        const line = buf.getLine(start + i);
        if (!line) {
          rawRows.push({ text: "", isWrapped: false });
          continue;
        }
        rawRows.push({
          text: line.translateToString(true),
          isWrapped: line.isWrapped,
        });
      }
      const lines = trimTrailingBlankLines(mergeWrappedRows(rawRows));
      return {
        lines,
        fontFamily: term.options.fontFamily ?? "monospace",
        fontSize: term.options.fontSize ?? 14,
      };
    }, []);

    const { fitToContainer, resizeLocalTerminal } = useTerminalFitController({
      termRef,
      wsRef,
      fitRef,
      viewportSizeRef,
      displayMode,
      isControllerRef,
      canResizeTerminalRef,
      scheduleMeasure,
    });

    // Expose imperative API
    useImperativeHandle(
      ref,
      () => ({
        sendComposer(message) {
          if (!canTypeRef.current || !isControllerRef.current) return Promise.reject(new Error("Take control before sending."));
          inputBatcherRef.current?.flush();
          return composerTransport.send(message);
        },
        sendInput(data: string) {
          // Route through the same batcher as onData input so key-bar bytes
          // stay ordered with keyboard bytes. The ref is only null before
          // the mount effect runs.
          const batcher = inputBatcherRef.current;
          if (batcher) {
            batcher.push(data);
            return;
          }
          const ws = wsRef.current;
          if (ws?.readyState === WebSocket.OPEN && canTypeRef.current) {
            ws.send(JSON.stringify({ type: "input", data }));
          }
        },
        sendCommandInput(data: string) {
          inputBatcherRef.current?.flush();
          const ws = wsRef.current;
          if (ws?.readyState === WebSocket.OPEN && canTypeRef.current) {
            ws.send(JSON.stringify({ type: "command_input", data }));
          }
        },
        fitToContainer(opts) {
          // Refresh the viewport measurement synchronously first. Fit
          // requests arrive right after layout changes (split, rotate,
          // zoom) that no longer remount this view, and the rAF-debounced
          // ResizeObserver measure can lose the race against the fit —
          // computing dimensions from the pre-change viewport size.
          measureLayout();
          fitToContainer(opts);
        },
        scrollToBottom() {
          termRef.current?.scrollToBottom();
        },
        focus() {
          termRef.current?.focus();
        },
        blur() {
          const active = document.activeElement;
          if (
            active instanceof HTMLElement &&
            containerRef.current?.contains(active)
          ) {
            active.blur();
          }
        },
        sendImageFile,
        setMouseTrackingEnabled,
        getSelection,
        getSelectionSnapshot,
      }),
      [composerTransport, fitToContainer, measureLayout, sendImageFile, setMouseTrackingEnabled, getSelection, getSelectionSnapshot],
    );

    // Create terminal once on mount — never recreated during reconnections
    // so that terminal modes (mouse tracking, alternate screen) are preserved.
    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      const { fontFamily, fontSize } = readTerminalFontPreferences();

      // The link currently under the pointer, kept by the hover/leave
      // callbacks below. Android WebViews do not synthesize the compat
      // mousedown/mouseup a tap needs for xterm's Linkifier to activate a
      // link (verified on-device: pointerdown/up and touchstart/end fire,
      // mouse events never do). The synthetic mousemove dispatched in
      // onTouchStart makes the Linkifier register the link under the finger
      // and call hover; onTouchEnd then activates it directly on a tap.
      let hoveredLink: string | null = null;

      const term = new Terminal({
        disableStdin: !directInputRef.current,
        cols,
        rows,
        fontSize,
        lineHeight: 1,
        letterSpacing: 0,
        fontFamily,
        allowTransparency: false,
        rescaleOverlappingGlyphs: true,
        theme: terminalTheme,
        cursorBlink: true,
        scrollback: 0,
        // 6.1 defaults showScrollbar to true and draws `.xterm-scrollbar`.
        // Scrollback is 0 (tmux copy-mode owns history), so the slider is
        // chrome we never want.
        scrollbar: { showScrollbar: false },
        macOptionClickForcesSelection: true,
        // xterm dampens likely trackpad wheel deltas before emitting mouse
        // wheel reports. Keep small terminal scroll gestures responsive.
        scrollSensitivity: TERMINAL_SCROLL_SENSITIVITY,
        // OSC 8 hyperlinks have no default click action in xterm.js;
        // WebLinksAddon only covers plain-text URLs.
        linkHandler: {
          activate: (_event, url) => openExternalUrl(url),
          hover: (_event, url) => {
            hoveredLink = url;
          },
          leave: () => {
            hoveredLink = null;
          },
        },
      });

      const fit = new FitAddon();
      term.loadAddon(fit);
      term.loadAddon(
        new ClipboardAddon(
          undefined,
          createTerminalClipboardProvider({
            readText: clipboardRead,
            writeText: clipboardWrite,
          }),
        ),
      );
      term.loadAddon(
        new WebLinksAddon(
          (_event, url) => {
            openExternalUrl(url);
          },
          {
            hover: (_event, url) => {
              hoveredLink = url;
            },
            leave: () => {
              hoveredLink = null;
            },
          },
        ),
      );
      term.open(container);
      // GPU rendering with guarded activation: context loss or any failure
      // falls back to the DOM renderer, and the texture atlas is cleared
      // periodically to stay clear of the upstream atlas-corruption bug
      // that got WebGL removed in PR #230. See lib/terminalGpuRenderer.ts.
      const gpuRenderer = activateGpuRenderer(term);
      const restoreMouseCoordinates = patchScaledMouseCoordinates(term);
      const restoreCompositionHelper = patchCompositionHelperSendRace(term);
      scheduleMeasure();

      // Wheel reports drive tmux copy-mode (wheel-up enters, scrolling to the
      // bottom exits). Swallow the tiny direction reversals trackpads emit at
      // the end of a gesture — amplified by scrollSensitivity they'd re-enter
      // copy-mode right after the user scrolled back down, leaving the
      // terminal stuck showing the scroll position badge.
      const wheelGate = createWheelDirectionGate();
      term.attachCustomWheelEventHandler((ev) =>
        wheelGate(ev.deltaY, ev.deltaMode),
      );

      // Put xterm into mouse-tracking mode locally instead of relying on the
      // hub to emit the escape sequences. Hub-generated bytes wouldn't be
      // counted in the terminal's output_seq, which used to drift the client's
      // lastSeenSeq ahead of the hub and force AttachMode::Reset on every
      // reconnect. Writing locally keeps the WS byte stream pure PTY history.
      // SGR extended mode (1006) + all-motion tracking (1003).
      term.write("\x1b[?1003h\x1b[?1006h");

      termRef.current = term;
      fitRef.current = fit;

      // Expose the Terminal instance for Playwright E2E tests. Renderer DOM
      // shape is not stable across xterm versions, so tests read content via
      // `term.buffer.active.getLine(i).translateToString` through this map.
      // Gated behind localStorage("offdesk:e2e")==="1" so production builds
      // never expose live xterm internals on window.
      if (
        typeof window !== "undefined" &&
        typeof localStorage !== "undefined" &&
        localStorage.getItem("offdesk:e2e") === "1"
      ) {
        const winAny = window as unknown as {
          __offdeskTerminals?: Map<string, Terminal>;
        };
        if (!winAny.__offdeskTerminals) {
          winAny.__offdeskTerminals = new Map();
        }
        winAny.__offdeskTerminals.set(terminalId, term);
      }

      // Forward terminal input to the current WebSocket: xterm's hidden
      // textarea (and its IME composition handling) delivers data to onData
      // as it is committed. The optional transform hook is the
      // mobile Ctrl latch — it rewrites the armed key to its control byte.
      //
      // Same-tick bursts (the wheel-report loops during scroll) are
      // coalesced into one WS message; the batcher flushes in a microtask,
      // so keystroke latency is unchanged. Guards are evaluated at flush
      // time inside the send callback. Command/image sends flush first so
      // cross-type message ordering is preserved.
      const echoProbeEnabled =
        localStorage.getItem("offdesk:echo-probe") === "1";
      const batcher = createInputBatcher((data) => {
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN && canTypeRef.current) {
          ws.send(JSON.stringify({ type: "input", data }));
          if (echoProbeEnabled) {
            echoProbeSentAtRef.current = performance.now();
          }
        }
      });
      inputBatcherRef.current = batcher;
      term.onData((data) => {
        if (!directInputRef.current) return;
        const userInput = filterBrowserGeneratedTerminalInput(data);
        if (!userInput) return;
        const transformed =
          inputTransformRef?.current?.(userInput) ?? userInput;
        batcher.push(transformed);
      });

      // 25 MB cap per file — WS frames larger than this regularly choke the
      // browser and the hub forwarder. Drag-drop a bigger file: we skip it
      // and surface a console.warn so the user knows why it didn't land.
      const MAX_DROP_BYTES = MAX_IMAGE_PASTE_BYTES;

      // Send file bytes over the current WS using the shared `image_paste`
      // protocol. The machine handler writes to /tmp/<filename> and
      // bracketed-pastes the path, which both Claude Code and Codex accept.
      const sendFileToWs = (
        base64: string,
        mime: string,
        filename: string,
        options: { dedupeClipboardImage?: boolean } = {},
      ) => {
        if (!canTypeRef.current) return;
        if (options.dedupeClipboardImage) {
          const result = shouldSendClipboardImagePaste(
            recentClipboardImagePasteRef.current,
            { data: base64, mime },
          );
          recentClipboardImagePasteRef.current = result.recent;
          if (!result.send) return;
        }

        batcher.flush();
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(buildImagePasteMessage(base64, mime, filename)));
        }
      };

      // Ctrl+C / Cmd+C copies selection to clipboard instead of sending SIGINT
      // Ctrl+V / Cmd+V checks clipboard for images before letting xterm paste text
      term.attachCustomKeyEventHandler((event) => {
        // Keep app-level prefix keys out of xterm: the Ctrl+B trigger, and
        // every key while the engine is armed. Returning false covers
        // keydown, keypress and keyup so no stray input reaches the pty;
        // the window keydown listener does the actual dispatch. Compact
        // (phone) chrome has no prefix engine; the unfolded Fold screen
        // keeps it for hardware keyboards.
        const { prefixKey: pk, isCompact: compact } = prefixKeyRef.current;
        if (!compact && pk.isPrefixKeyEvent(event)) {
          return false;
        }

        const bulk = bulkKeypressText(event);
        if (bulk !== null) {
          event.preventDefault();
          // A dictation service can put an entire paragraph in `key`.
          // xterm's legacy handler reads only charCode and loses the tail.
          term.paste(bulk);
          return false;
        }

        if (
          (event.ctrlKey || event.metaKey) &&
          event.key === "c" &&
          event.type === "keydown"
        ) {
          if (term.hasSelection()) {
            event.preventDefault();
            void clipboardWrite(term.getSelection()).then(() => {
              term.clearSelection();
            }).catch((err) => {
              // eslint-disable-next-line no-console
              console.warn("[offdesk] Cmd/Ctrl+C clipboard write failed", err);
            });
            return false;
          }
        }

        // Cmd/Ctrl+V is handled by the native paste event below. Reading the
        // clipboard via navigator.clipboard.* trips macOS Sequoia's clipboard
        // privacy prompt (the "Paste" tooltip) — the paste event's
        // clipboardData already exposes both text and image items without
        // triggering it.

        return true;
      });

      // Intercept paste events for image detection
      const handlePaste = (e: ClipboardEvent) => {
        const items = e.clipboardData?.items;
        if (!items) return;
        const imageItem = Array.from(items).find((item) =>
          item.type.startsWith("image/"),
        );
        if (!imageItem) return;

        e.preventDefault();
        e.stopPropagation();
        const blob = imageItem.getAsFile();
        if (!blob) return;
        const reader = new FileReader();
        reader.onload = () => {
          const base64 = (reader.result as string).split(",")[1];
          const ext = imageItem.type.split("/")[1] || "png";
          sendFileToWs(
            base64,
            imageItem.type,
            safeFilename(blob.name, `.${ext}`),
            { dedupeClipboardImage: true },
          );
        };
        reader.readAsDataURL(blob);
      };
      container.addEventListener("paste", handlePaste, { capture: true });

      // Drag-and-drop file upload. Dropped files go through the same
      // image-paste pipeline on the machine side (save to /tmp, inject
      // the path as a bracketed paste into the PTY), which works for any
      // file type: Claude Code and Codex both accept a pasted path and
      // figure out whether it's an image / PDF / text themselves.
      const handleDragOver = (e: DragEvent) => {
        if (!e.dataTransfer?.types.includes("Files")) return;
        e.preventDefault();
        e.stopPropagation();
      };
      const handleDrop = (e: DragEvent) => {
        const files = e.dataTransfer?.files;
        if (!files || files.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        for (const file of Array.from(files)) {
          if (file.size > MAX_DROP_BYTES) {
            // eslint-disable-next-line no-console
            console.warn(
              `[offdesk] skipping ${file.name}: ${file.size} bytes exceeds ${MAX_DROP_BYTES}`,
            );
            continue;
          }
          const reader = new FileReader();
          reader.onload = () => {
            const base64 = (reader.result as string).split(",")[1];
            sendFileToWs(
              base64,
              file.type || "application/octet-stream",
              safeFilename(file.name),
            );
          };
          reader.readAsDataURL(file);
        }
      };
      container.addEventListener("dragover", handleDragOver);
      container.addEventListener("drop", handleDrop);

      // Suppress the browser default context menu on the terminal — the custom
      // context menu is rendered by TerminalWorkspace.web.tsx via an
      // onContextMenu handler on the wrapping pane div.
      const handleContextMenu = (e: MouseEvent) => {
        e.preventDefault();
      };
      container.addEventListener("contextmenu", handleContextMenu);

      // Copy-on-select: when the user finishes a drag/double-click/triple-click
      // selection, push the highlighted text to the clipboard so ⌘V elsewhere
      // works without having to press ⌘C first.
      //
      // Mirror xterm's own SelectionService pattern: on mousedown inside the
      // terminal, attach a one-shot mouseup listener to `document`. This way
      // the copy fires even when the user releases the mouse outside the
      // terminal viewport (e.g. dragging down past the workspace toolbar),
      // and unrelated clicks elsewhere on the page never trigger a re-write.
      //
      // Also listen to xterm's selection-change event. That fires after xterm
      // finalizes its internal selection state, which avoids platform-specific
      // mouseup ordering differences in WebViews.
      const selectionAutoCopy = createSelectionAutoCopyController({
        hasSelection: () => term.hasSelection(),
        getSelection: () => term.getSelection(),
        writeText: clipboardWrite,
        onError: (err) => {
          // eslint-disable-next-line no-console
          console.warn("[offdesk] copy-on-select clipboard write failed", err);
        },
      });
      const selectionChangeDisposable = term.onSelectionChange(() => {
        selectionAutoCopy.selectionChanged();
      });
      const handleSelectMouseUp = () => {
        selectionAutoCopy.pointerSelectionFinished();
      };
      const handleSelectMouseDown = () => {
        selectionAutoCopy.pointerSelectionStarted();
        document.addEventListener("mouseup", handleSelectMouseUp, { once: true });
      };
      container.addEventListener("mousedown", handleSelectMouseDown);

      // Touch scroll handling for mobile. Quantize finger travel with the
      // measured cell height, not fontSize*lineHeight: rendered cells are
      // taller than that for most fonts (14px font → 17px cell), and xterm
      // re-quantizes wheel deltas against its own cell metrics, so a
      // misestimated quantum loses ~20% of the scroll distance.
      const lineHeight =
        readXtermCellMetrics(term)?.height ??
        (term.options.fontSize ?? 14) * (term.options.lineHeight ?? 1);
      let lastTouchY = 0;
      let accumulatedDelta = 0;
      let tapStart: { x: number; y: number; at: number } | null = null;

      // Flick momentum: recent (time, clientY) samples measure release
      // velocity; a rAF loop then keeps feeding pixels into the same
      // wheel-report pipeline with exponential decay. Without this, lifting
      // the finger stops the scroll dead — tmux copy-mode has no inertia of
      // its own. Samples use event.timeStamp (not receipt time): Chromium
      // coalesces touchmove delivery, so performance.now() at the handler
      // can lag the actual touch by tens of ms and mismeasure velocity.
      let velocitySamples: { t: number; y: number }[] = [];
      let momentumRaf = 0;
      let lastMomentumPos = { x: 0, y: 0 };
      let tapInterruptedMomentum = false;

      const stopMomentum = () => {
        if (momentumRaf) {
          cancelAnimationFrame(momentumRaf);
          momentumRaf = 0;
        }
      };

      // Convert vertical pixel travel into per-line synthetic wheel events on
      // the xterm viewport (xterm turns them into SGR reports for tmux).
      const scrollByPixels = (dy: number, clientX: number, clientY: number) => {
        accumulatedDelta += dy;
        const lines = Math.trunc(accumulatedDelta / lineHeight);
        if (lines === 0) return;
        const vp = container.querySelector(".xterm-viewport");
        if (vp) {
          for (let i = 0; i < Math.abs(lines); i++) {
            vp.dispatchEvent(
              new WheelEvent("wheel", {
                deltaY: lines > 0 ? lineHeight : -lineHeight,
                clientX,
                clientY,
                bubbles: true,
                cancelable: true,
              }),
            );
          }
        }
        accumulatedDelta -= lines * lineHeight;
      };

      const MOMENTUM_MIN_START = 0.4; // px/ms — slower lifts are a stop, not a flick
      const MOMENTUM_MIN_KEEP = 0.05; // px/ms — decay floor
      const MOMENTUM_DECAY = 0.94; // per 16.7ms frame

      const startMomentum = (endedAt: number) => {
        // Velocity from the samples inside the last 100ms of the gesture.
        // If that window is sparse (dropped touchmoves, or CDP/test pacing
        // slower than a real 16ms poll), fall back to the last two samples
        // so a real flick still gets an inertia estimate.
        let window_ = velocitySamples.filter((s) => endedAt - s.t <= 100);
        if (window_.length < 2) {
          window_ = velocitySamples.slice(-2);
        }
        if (window_.length < 2) return;
        const first = window_[0];
        const last = window_[window_.length - 1];
        const dt = last.t - first.t;
        if (dt <= 0) return;
        let velocity = (first.y - last.y) / dt; // + = scroll down (finger up)
        if (Math.abs(velocity) < MOMENTUM_MIN_START) return;

        let prevFrame = endedAt;
        const step = (frameTime: number) => {
          const frameDt = Math.min(frameTime - prevFrame, 50);
          prevFrame = frameTime;
          scrollByPixels(
            velocity * frameDt,
            lastMomentumPos.x,
            lastMomentumPos.y,
          );
          velocity *= Math.pow(MOMENTUM_DECAY, frameDt / 16.7);
          if (Math.abs(velocity) >= MOMENTUM_MIN_KEEP) {
            momentumRaf = requestAnimationFrame(step);
          } else {
            momentumRaf = 0;
          }
        };
        momentumRaf = requestAnimationFrame(step);
      };

      const onTouchStart = (e: TouchEvent) => {
        e.stopPropagation();
        const touch = e.touches[0];
        if (touch) {
          // A tap that lands mid-momentum is "stop scrolling", not a tap on
          // whatever link happens to slide under the finger.
          tapInterruptedMomentum = momentumRaf !== 0;
          stopMomentum();
          lastTouchY = touch.clientY;
          accumulatedDelta = 0;
          velocitySamples = [{ t: e.timeStamp, y: touch.clientY }];
          tapStart =
            e.touches.length === 1
              ? { x: touch.clientX, y: touch.clientY, at: Date.now() }
              : null;
          // Android WebViews do not synthesize compat mouse events for taps
          // at all (verified on-device: no mousemove/mousedown/mouseup ever
          // fire), so xterm's Linkifier can never see the link under the
          // finger by itself. Prime it with a synthetic hover at the touch
          // point — the hover/leave callbacks record the link so onTouchEnd
          // can activate it directly. Harmless where the browser does send
          // its own mouse events (openExternalUrl dedupes).
          e.target?.dispatchEvent(
            new MouseEvent("mousemove", {
              clientX: touch.clientX,
              clientY: touch.clientY,
              bubbles: true,
            }),
          );
        }
      };
      const onTouchEnd = (e: TouchEvent) => {
        const start = tapStart;
        tapStart = null;
        const touch = e.changedTouches[0];
        if (e.touches.length === 0) {
          startMomentum(e.timeStamp);
          velocitySamples = [];
        }
        if (!start || !touch) return;
        const moved = Math.hypot(
          touch.clientX - start.x,
          touch.clientY - start.y,
        );
        // A tap, not a scroll or a long-press: activate the link the
        // synthetic hover registered under the finger.
        if (
          moved <= 14 &&
          Date.now() - start.at <= 500 &&
          hoveredLink &&
          !tapInterruptedMomentum
        ) {
          stopMomentum();
          openExternalUrl(hoveredLink);
        }
      };
      const onTouchMove = (e: TouchEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const touch = e.touches[0];
        if (touch) {
          const currentY = touch.clientY;
          velocitySamples.push({ t: e.timeStamp, y: currentY });
          if (velocitySamples.length > 8) velocitySamples.shift();
          lastMomentumPos = { x: touch.clientX, y: touch.clientY };
          scrollByPixels(lastTouchY - currentY, touch.clientX, touch.clientY);
          lastTouchY = currentY;
        }
      };
      container.addEventListener("touchstart", onTouchStart, { passive: true });
      container.addEventListener("touchmove", onTouchMove, { passive: false });
      container.addEventListener("touchend", onTouchEnd, { passive: true });

      const viewport = viewportRef.current;
      const resizeObserver = new ResizeObserver(() => {
        scheduleMeasure();
      });
      if (viewport) {
        resizeObserver.observe(viewport);
      }

      return () => {
        batcher.flush();
        if (inputBatcherRef.current === batcher) {
          inputBatcherRef.current = null;
        }
        resizeObserver.disconnect();
        if (measureRafRef.current) {
          cancelAnimationFrame(measureRafRef.current);
          measureRafRef.current = null;
        }
        container.removeEventListener("paste", handlePaste, { capture: true });
        container.removeEventListener("dragover", handleDragOver);
        container.removeEventListener("drop", handleDrop);
        container.removeEventListener("contextmenu", handleContextMenu);
        container.removeEventListener("mousedown", handleSelectMouseDown);
        document.removeEventListener("mouseup", handleSelectMouseUp);
        selectionAutoCopy.dispose();
        selectionChangeDisposable.dispose();
        stopMomentum();
        container.removeEventListener("touchstart", onTouchStart);
        container.removeEventListener("touchmove", onTouchMove);
        container.removeEventListener("touchend", onTouchEnd);
        if (typeof window !== "undefined") {
          const winAny = window as unknown as {
            __offdeskTerminals?: Map<string, Terminal>;
          };
          // Map only exists when the test-hook flag was set; delete is a no-op
          // otherwise because the map itself was never created.
          winAny.__offdeskTerminals?.delete(terminalId);
        }
        restoreMouseCoordinates();
        restoreCompositionHelper();
        gpuRenderer.dispose();
        term.dispose();
        if (termRef.current === term) {
          termRef.current = null;
        }
        if (fitRef.current === fit) {
          fitRef.current = null;
        }
      };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Terminal created once on mount
    }, []);

    // Keep the live terminal and its buffer/socket while preferences change.
    useEffect(() => {
      const term = termRef.current;
      if (!term) return;
      let disposed = false;
      let revision = 0;
      let applied = readTerminalFontPreferences();
      const update = async (allowFit: boolean) => {
        const current = ++revision;
        const { fontFamily, fontSize } = readTerminalFontPreferences();
        const changed = fontFamily !== applied.fontFamily || fontSize !== applied.fontSize;
        // Load before measuring. Otherwise a newly downloaded webfont retains
        // the fallback font's cell metrics and clips/overlaps terminal output.
        try { await document.fonts?.load(`${fontSize}px ${fontFamily}`); } catch { /* use fallback */ }
        if (disposed || current !== revision || termRef.current !== term) return;
        // An equivalent spelling forces xterm's public option-change path to
        // remeasure even when the configured family was already set at mount.
        term.options.fontFamily = `${fontFamily} `;
        term.options.fontFamily = fontFamily;
        term.options.fontSize = fontSize;
        term.clearTextureAtlas();
        term.refresh(0, term.rows - 1);
        scheduleMeasure();
        applied = { fontFamily, fontSize };
        // Opening/reconnecting a view must preserve the remote PTY size.
        // Only an actual preference change authorizes a new fit here.
        if (allowFit && changed) fitToContainer({ skipIfUnchanged: true });
      };
      void update(false);
      const unsubscribe = subscribeFontPreferences(() => { void update(true); });
      return () => { disposed = true; unsubscribe(); };
    }, [fitToContainer, scheduleMeasure]);

    useTerminalLiveSocket({
      onControlMessage: composerTransport.receive,
      onSocketClose: composerTransport.close,
      termRef,
      wsRef,
      wsUrl,
      terminalId,
      echoProbeSentAtRef,
      scheduleMeasure,
      sessionGeneration,
      setSessionGeneration,
      onReconnectingChange,
    });

    useEffect(() => {
      const term = termRef.current;
      if (!term) return;
      if (term.cols === cols && term.rows === rows) return;
      resizeLocalTerminal(cols, rows);
    }, [cols, resizeLocalTerminal, rows]);

    useEffect(() => {
      scheduleMeasure();
    }, [displayMode, scheduleMeasure]);

    const liveJustifyContent =
      displayMode === "immersive" &&
      surfaceSize.width > 0 &&
      viewportSize.width >= surfaceSize.width
        ? "center"
        : "flex-start";
    const frameWidth =
      displayMode === "immersive" && surfaceSize.width > 0
        ? `${surfaceSize.width}px`
        : "100%";
    const frameHeight =
      displayMode === "immersive" && surfaceSize.height > 0
        ? `${surfaceSize.height}px`
        : "100%";

    return (
      <div
        ref={viewportRef}
        data-terminal-display-mode={displayMode}
        data-terminal-view-scale="1.0000"
        data-terminal-view-justify={liveJustifyContent}
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          justifyContent:
            displayMode === "immersive" ? liveJustifyContent : "flex-start",
          alignItems: "flex-start",
          overflow: "hidden",
          ...style,
        }}
      >
        <div
          style={{
            width: frameWidth,
            height: frameHeight,
            flex: "0 0 auto",
          }}
        >
          <div
            ref={containerRef}
            style={{
              width: displayMode === "immersive" ? undefined : "100%",
              height: displayMode === "immersive" ? undefined : "100%",
              display: displayMode === "immersive" ? "inline-block" : "block",
            }}
          />
        </div>
      </div>
    );
  },
);
