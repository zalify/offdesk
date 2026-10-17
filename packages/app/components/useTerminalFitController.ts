import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";

import { buildResizeMessage } from "@/lib/terminalResize";
import {
  getTerminalFitDimensions,
  getTerminalFitResizeDecision,
  type TerminalDisplayMode,
} from "@/lib/terminalViewModel";
import { readXtermCellMetrics } from "./terminalXtermMetrics";

const FIT_RETRY_LIMIT = 10;
const FIT_RETRY_DELAY_MS = 100;

interface TerminalSize {
  width: number;
  height: number;
}

interface UseTerminalFitControllerOptions {
  termRef: RefObject<Terminal | null>;
  wsRef: RefObject<WebSocket | null>;
  fitRef: RefObject<FitAddon | null>;
  viewportSizeRef: RefObject<TerminalSize>;
  displayMode: TerminalDisplayMode;
  isControllerRef: RefObject<boolean>;
  canResizeTerminalRef: RefObject<boolean>;
  scheduleMeasure: () => void;
  // A resize frame went out: tmux redraws at the new size, so what is on
  // screen until that redraw arrives is stale.
  onResizeSent?: () => void;
}

export function useTerminalFitController({
  termRef,
  wsRef,
  fitRef,
  viewportSizeRef,
  displayMode,
  isControllerRef,
  canResizeTerminalRef,
  scheduleMeasure,
  onResizeSent,
}: UseTerminalFitControllerOptions) {
  const fitRetryTimerRef = useRef<number | null>(null);
  // A fit requested before the socket opened, run by runFitAwaitingOpen.
  const fitAwaitingOpenRef = useRef<{ skipIfUnchanged: boolean } | null>(null);
  const onResizeSentRef = useRef(onResizeSent);
  onResizeSentRef.current = onResizeSent;

  const clearFitRetryTimer = useCallback(() => {
    if (fitRetryTimerRef.current !== null) {
      window.clearTimeout(fitRetryTimerRef.current);
      fitRetryTimerRef.current = null;
    }
  }, []);

  const stabilizeTerminalSurface = useCallback(
    (term: Terminal) => {
      try {
        term.clearTextureAtlas();
      } catch {
        /* ignore */
      }

      const refresh = () => {
        if (termRef.current !== term) return;
        term.refresh(0, Math.max(term.rows - 1, 0));
        scheduleMeasure();
      };

      refresh();
      requestAnimationFrame(() => {
        refresh();
        requestAnimationFrame(refresh);
      });
    },
    [scheduleMeasure, termRef],
  );

  const resizeLocalTerminal = useCallback(
    (nextCols: number, nextRows: number) => {
      const term = termRef.current;
      if (!term) return;
      if (term.cols === nextCols && term.rows === nextRows) {
        stabilizeTerminalSurface(term);
        return;
      }
      try {
        term.resize(nextCols, nextRows);
        stabilizeTerminalSurface(term);
      } catch {
        /* ignore */
      }
    },
    [stabilizeTerminalSurface, termRef],
  );

  const fitToContainer = useCallback(
    (opts: { attempt?: number; skipIfUnchanged?: boolean } = {}) => {
      const attempt = opts.attempt ?? 0;
      const skipIfUnchanged = opts.skipIfUnchanged ?? false;
      const scheduleRetry = () => {
        if (attempt >= FIT_RETRY_LIMIT) return;
        clearFitRetryTimer();
        fitRetryTimerRef.current = window.setTimeout(() => {
          fitRetryTimerRef.current = null;
          fitToContainer({ attempt: attempt + 1, skipIfUnchanged });
        }, FIT_RETRY_DELAY_MS);
      };

      const fit = fitRef.current;
      const liveWs = wsRef.current;
      if (!isControllerRef.current || !canResizeTerminalRef.current) return;
      if (liveWs?.readyState !== WebSocket.OPEN) {
        // Wait for the socket rather than poll: over a remote link it can
        // take longer to open than the retry budget lasts, and fitting from
        // its open handler sends the resize before any attach output.
        clearFitRetryTimer();
        fitAwaitingOpenRef.current = { skipIfUnchanged };
        return;
      }
      fitAwaitingOpenRef.current = null;

      try {
        const term = termRef.current;
        let nextDims: { cols: number; rows: number } | null;
        if (displayMode === "immersive") {
          const cellMetrics = term ? readXtermCellMetrics(term) : null;
          if (!cellMetrics) {
            scheduleRetry();
            return;
          }
          nextDims = getTerminalFitDimensions({
            viewportWidth: viewportSizeRef.current.width,
            viewportHeight: viewportSizeRef.current.height,
            cellWidth: cellMetrics.width,
            cellHeight: cellMetrics.height,
          });
        } else {
          if (!fit) {
            scheduleRetry();
            return;
          }
          fit.fit();
          nextDims = fit.proposeDimensions() ?? null;
        }

        const resizeMessage = buildResizeMessage(nextDims);
        if (!resizeMessage) {
          scheduleRetry();
          return;
        }
        clearFitRetryTimer();
        if (skipIfUnchanged) {
          const live = termRef.current;
          if (!live) return;
          const decision = getTerminalFitResizeDecision({
            currentCols: live.cols,
            currentRows: live.rows,
            nextCols: resizeMessage.cols,
            nextRows: resizeMessage.rows,
            skipIfUnchanged,
          });
          if (!decision.sendResizeFrame) {
            if (decision.refreshLocalSurface) stabilizeTerminalSurface(live);
            return;
          }
        }
        liveWs.send(JSON.stringify(resizeMessage));
        onResizeSentRef.current?.();
        resizeLocalTerminal(resizeMessage.cols, resizeMessage.rows);
      } catch {
        scheduleRetry();
      }
    },
    [
      canResizeTerminalRef,
      clearFitRetryTimer,
      displayMode,
      fitRef,
      isControllerRef,
      resizeLocalTerminal,
      stabilizeTerminalSurface,
      termRef,
      viewportSizeRef,
      wsRef,
    ],
  );

  const runFitAwaitingOpen = useCallback(() => {
    const awaiting = fitAwaitingOpenRef.current;
    if (!awaiting) return;
    fitAwaitingOpenRef.current = null;
    fitToContainer(awaiting);
  }, [fitToContainer]);

  useEffect(() => clearFitRetryTimer, [clearFitRetryTimer]);

  return {
    fitToContainer,
    runFitAwaitingOpen,
    resizeLocalTerminal,
    stabilizeTerminalSurface,
  };
}
