export type TerminalDisplayMode = "card" | "immersive";

export interface TerminalControlCopy {
  modeLabel: string;
  toggleLabel: string;
  sizeActionLabel: string;
}

interface TerminalFitDimensionsInput {
  // Available pixel space the rendered terminal must fit into.
  viewportWidth: number;
  viewportHeight: number;
  // True per-cell pixel size for the live font/zoom — read from the
  // terminal renderer, never reverse-engineered from a DOM measurement.
  cellWidth: number;
  cellHeight: number;
  // Optional CSS chrome (padding/border) that subtracts from the viewport
  // before we divide by cell size. Defaults to 0.
  paddingX?: number;
  paddingY?: number;
  // Lower bounds for safety. Defaults match xterm's FitAddon.
  minCols?: number;
  minRows?: number;
}

export interface TerminalFitResizeDecisionInput {
  currentCols: number;
  currentRows: number;
  nextCols: number;
  nextRows: number;
  skipIfUnchanged: boolean;
}

export interface TerminalFitResizeDecision {
  sendResizeFrame: boolean;
  refreshLocalSurface: boolean;
}

interface EstimateInitialTerminalDimensionsOptions {
  cellWidth?: number;
  cellHeight?: number;
  minCols?: number;
  minRows?: number;
  maxCols?: number;
  maxRows?: number;
}

const DESKTOP_ESTIMATE_CELL_WIDTH = 8.5;
const DESKTOP_ESTIMATE_CELL_HEIGHT = 17;

// Mobile fullscreen terminals sit inside the mobile TerminalWorkspace +
// TerminalCard chrome before xterm exists, so creation needs to estimate the
// inner terminal viewport rather than the whole screen.
const MOBILE_TERMINAL_HORIZONTAL_CHROME_PX = 20;
const MOBILE_TERMINAL_VERTICAL_CHROME_PX = 194;
const MOBILE_ESTIMATE_CELL_WIDTH = 7.1;
const MOBILE_ESTIMATE_CELL_HEIGHT = 17;

export function getTerminalControlCopy(
  isController: boolean,
): TerminalControlCopy {
  return {
    modeLabel: isController ? "Controlling" : "Viewing",
    toggleLabel: isController ? "Stop Control" : "Control Here",
    sizeActionLabel: "Fit to Window",
  };
}

/**
 * Estimate cols/rows for a *new* terminal from a pixel viewport before any
 * xterm instance exists to measure. Uses the default font metrics
 * (monospace 14px) so the server creates the tmux session close to the
 * size it will actually be shown at — the alternative (hardcoded 80x24)
 * makes TUIs like Claude Code draw their welcome banner narrow, which
 * SIGWINCH on later resize can't repaint.
 */
export function estimateInitialTerminalDimensions(
  viewportWidthPx: number,
  viewportHeightPx: number,
  options: EstimateInitialTerminalDimensionsOptions = {},
): { cols: number; rows: number } {
  const cellWidth = options.cellWidth ?? DESKTOP_ESTIMATE_CELL_WIDTH;
  const cellHeight = options.cellHeight ?? DESKTOP_ESTIMATE_CELL_HEIGHT;
  const minCols = options.minCols ?? 80;
  const minRows = options.minRows ?? 24;
  const maxCols = options.maxCols ?? 400;
  const maxRows = options.maxRows ?? 200;
  const cols = Math.max(
    minCols,
    Math.min(maxCols, Math.floor(viewportWidthPx / cellWidth)),
  );
  const rows = Math.max(
    minRows,
    Math.min(maxRows, Math.floor(viewportHeightPx / cellHeight)),
  );
  return { cols, rows };
}

/**
 * Banner predicate for "Sized by another device": is the terminal well under
 * what would fit in this pane? Unlike initial terminal creation the estimate
 * must not floor at 80×24 — in a narrow pane that floor alone (80 cols) is
 * wider than the terminal (e.g. 26 cols in a ~250px pane), which made the
 * banner fire on correctly fitted panes.
 */
export function isSizedElsewhere(
  terminalCols: number,
  terminalRows: number,
  paneWidthPx: number,
  paneHeightPx: number,
): boolean {
  const wouldFit = estimateInitialTerminalDimensions(paneWidthPx, paneHeightPx, {
    minCols: 1,
    minRows: 1,
  });
  return (
    terminalCols < wouldFit.cols * 0.6 || terminalRows < wouldFit.rows * 0.6
  );
}

export function estimateMobileInitialTerminalDimensions(
  viewportWidthPx: number,
  viewportHeightPx: number,
): { cols: number; rows: number } {
  return estimateInitialTerminalDimensions(
    Math.max(0, viewportWidthPx - MOBILE_TERMINAL_HORIZONTAL_CHROME_PX),
    Math.max(0, viewportHeightPx - MOBILE_TERMINAL_VERTICAL_CHROME_PX),
    {
      cellWidth: MOBILE_ESTIMATE_CELL_WIDTH,
      cellHeight: MOBILE_ESTIMATE_CELL_HEIGHT,
      minCols: 40,
      minRows: 12,
    },
  );
}

// Compute the next cols/rows that fit inside `viewport` given the live cell
// metrics. Cell width and height MUST come from the terminal renderer
// (xterm 6.1: `term.dimensions.css.cell.{width,height}`, with the private
// `_core._renderService` path as fallback).
// Reverse-engineering cell size from a
// cached surface measurement (contentWidth / cols) creates a race where
// `term.cols` updates synchronously but the surface cache lags one RAF
// behind, producing wildly wrong dimensions on rapid back-to-back fits.
export function getTerminalFitDimensions({
  viewportWidth,
  viewportHeight,
  cellWidth,
  cellHeight,
  paddingX = 0,
  paddingY = 0,
  minCols = 2,
  minRows = 1,
}: TerminalFitDimensionsInput): { cols: number; rows: number } | null {
  if (
    !Number.isFinite(cellWidth) ||
    !Number.isFinite(cellHeight) ||
    cellWidth <= 0 ||
    cellHeight <= 0
  ) {
    return null;
  }

  const availableWidth = viewportWidth - paddingX;
  const availableHeight = viewportHeight - paddingY;
  if (availableWidth <= 0 || availableHeight <= 0) {
    return null;
  }

  const nextCols = Math.max(minCols, Math.floor(availableWidth / cellWidth));
  const nextRows = Math.max(minRows, Math.floor(availableHeight / cellHeight));
  return {
    cols: nextCols,
    rows: nextRows,
  };
}

export function getTerminalFitResizeDecision({
  currentCols,
  currentRows,
  nextCols,
  nextRows,
  skipIfUnchanged,
}: TerminalFitResizeDecisionInput): TerminalFitResizeDecision {
  const unchanged = currentCols === nextCols && currentRows === nextRows;
  if (skipIfUnchanged && unchanged) {
    return {
      sendResizeFrame: false,
      refreshLocalSurface: true,
    };
  }

  return {
    sendResizeFrame: true,
    refreshLocalSurface: true,
  };
}
