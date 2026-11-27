import test from "node:test";
import assert from "node:assert/strict";

import {
  estimateInitialTerminalDimensions,
  estimateMobileInitialTerminalDimensions,
  getTerminalControlCopy,
  getTerminalFitDimensions,
  getTerminalFitResizeDecision,
} from "./terminalViewModel.ts";

test("view-only sessions use simplified control copy", () => {
  assert.deepEqual(getTerminalControlCopy(false), {
    modeLabel: "Viewing",
    toggleLabel: "Control Here",
    sizeActionLabel: "Fit to Window",
  });
});

test("controlled sessions use simplified control copy", () => {
  assert.deepEqual(getTerminalControlCopy(true), {
    modeLabel: "Controlling",
    toggleLabel: "Stop Control",
    sizeActionLabel: "Fit to Window",
  });
});

test("fit dimensions divide viewport by the supplied cell metrics", () => {
  // Same scenario as before: 370x420 viewport, 8.3375 x 16 cell.
  assert.deepEqual(
    getTerminalFitDimensions({
      viewportWidth: 370,
      viewportHeight: 420,
      cellWidth: 667 / 80,
      cellHeight: 384 / 24,
    }),
    {
      cols: 44,
      rows: 26,
    },
  );
});

test("fit dimensions converge after one click — repeating with the same cell metrics is a fixed point", () => {
  // Regression: the previous reverse-derived implementation would oscillate
  // when surface measurements lagged behind term.cols. With direct cell
  // metrics the function is a pure projection of viewport onto cell size,
  // so any second invocation returns the same answer.
  const cellWidth = 8.4;
  const cellHeight = 17;
  const viewport = { viewportWidth: 1440, viewportHeight: 900 };
  const first = getTerminalFitDimensions({
    ...viewport,
    cellWidth,
    cellHeight,
  });
  const second = getTerminalFitDimensions({
    ...viewport,
    cellWidth,
    cellHeight,
  });
  assert.deepEqual(first, second);
  assert.deepEqual(first, { cols: 171, rows: 52 });
});

test("fit dimensions subtract padding from the viewport before dividing", () => {
  // Any renderer chrome that takes pixels from the terminal viewport must be
  // subtracted before computing cols/rows.
  assert.deepEqual(
    getTerminalFitDimensions({
      viewportWidth: 800,
      viewportHeight: 600,
      cellWidth: 8,
      cellHeight: 16,
      paddingX: 24,
      paddingY: 24,
    }),
    {
      cols: Math.floor((800 - 24) / 8),
      rows: Math.floor((600 - 24) / 16),
    },
  );
});

test("fit dimensions return null when cell metrics are missing", () => {
  assert.equal(
    getTerminalFitDimensions({
      viewportWidth: 800,
      viewportHeight: 600,
      cellWidth: 0,
      cellHeight: 16,
    }),
    null,
  );
  assert.equal(
    getTerminalFitDimensions({
      viewportWidth: 800,
      viewportHeight: 600,
      cellWidth: 8,
      cellHeight: NaN,
    }),
    null,
  );
});

test("fit dimensions clamp to a sensible minimum when viewport is tiny", () => {
  // Even when the viewport collapses to almost nothing we never propose
  // 0×0 — the server-side PTY rejects that. xterm's FitAddon clamps the
  // same way (cols≥2, rows≥1).
  assert.deepEqual(
    getTerminalFitDimensions({
      viewportWidth: 5,
      viewportHeight: 5,
      cellWidth: 100,
      cellHeight: 100,
    }),
    {
      cols: 2,
      rows: 1,
    },
  );
});

test("unchanged auto-fit suppresses both remote resize frame and redundant local refresh", () => {
  assert.deepEqual(
    getTerminalFitResizeDecision({
      currentCols: 52,
      currentRows: 27,
      nextCols: 52,
      nextRows: 27,
      skipIfUnchanged: true,
    }),
    {
      sendResizeFrame: false,
      refreshLocalSurface: false,
    },
  );
});

test("estimateInitialTerminalDimensions produces a reasonable desktop default", () => {
  // 1440×900 desktop → comfortably more than 80×24
  const { cols, rows } = estimateInitialTerminalDimensions(1440, 900);
  assert.ok(cols > 80, `expected cols > 80, got ${cols}`);
  assert.ok(rows > 24, `expected rows > 24, got ${rows}`);
});

test("estimateInitialTerminalDimensions enforces the 80×24 lower bound", () => {
  // Tiny / zero input still returns a sensible minimum so the server
  // never sees cols=0/rows=0 in the POST body.
  assert.deepEqual(estimateInitialTerminalDimensions(0, 0), {
    cols: 80,
    rows: 24,
  });
  assert.deepEqual(estimateInitialTerminalDimensions(100, 100), {
    cols: 80,
    rows: 24,
  });
});

test("estimateInitialTerminalDimensions clamps at 400×200 to block runaway values", () => {
  const { cols, rows } = estimateInitialTerminalDimensions(10_000, 10_000);
  assert.equal(cols, 400);
  assert.equal(rows, 200);
});

test("estimateMobileInitialTerminalDimensions accounts for mobile overlay chrome", () => {
  const { cols, rows } = estimateMobileInitialTerminalDimensions(390, 664);
  assert.deepEqual({ cols, rows }, { cols: 52, rows: 27 });
});
