export interface NativeTermSpanLike {
  c: number;
  t: string;
}

export interface NativeTermFrameLike {
  cols: number;
  rows: number;
  spans: NativeTermSpanLike[][];
  display_offset: number;
  history_size?: number;
  wrapped_rows?: boolean[];
}

export interface CellPoint {
  col: number;
  row: number;
}

export interface DocPoint {
  col: number;
  docRow: number;
}

export interface StoredRow {
  chars: string[];
  plain: string;
  wrapped: boolean;
}

export interface ScrollBand {
  top: number;
  bottom: number;
}

export interface VisibleSelectionRow {
  row: number;
  startCol: number;
  endCol: number;
}

export interface NativeSelectionState {
  start: DocPoint;
  end: DocPoint;
  rectangular: boolean;
  /** Logical docRow currently displayed at visible viewport row 0. */
  viewportTopDocRow: number;
  /** Stitched document rows keyed by docRow. */
  lines: Map<number, StoredRow>;
  lastCols: number;
  lastRows: number;
  lastDisplayOffset: number;
  lastHistorySize: number | undefined;
  lastPlainRows: string[];
  /** Detected scrollable band for TUIs with fixed headers/footers. */
  scrollBand: ScrollBand | null;
}

const MAX_STORED_LINES = 20_000;

export function isWideChar(cp: number): boolean {
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

export function extractFrameRows(frame: NativeTermFrameLike): StoredRow[] {
  const rows: StoredRow[] = new Array(frame.rows);
  for (let r = 0; r < frame.rows; r++) {
    const chars = new Array<string>(frame.cols).fill(" ");
    const rowSpans = frame.spans[r] ?? [];
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
    rows[r] = {
      chars,
      plain: chars.join("").trimEnd(),
      wrapped: Boolean(frame.wrapped_rows?.[r]),
    };
  }
  return rows;
}

/**
 * Detect vertical content shift between two equal-height terminal frames.
 * Returns `shift > 0` when content moved DOWN (scrolled UP into older history),
 * `shift < 0` when content moved UP (scrolled DOWN / new output), or `0` when
 * no vertical scroll was detected.
 *
 * Also identifies the scrolling `band` [top, bottom] so TUIs with fixed headers
 * or footers (e.g. Claude Code's input bar, tmux status line) do not interfere
 * with shift detection or overwrite scrolled-off content.
 */
export function detectScrollShift(
  prev: string[],
  next: string[],
  preferredDirection: -1 | 0 | 1 = 0,
): { shift: number; band: ScrollBand | null } {
  const n = prev.length;
  if (n === 0 || n !== next.length) return { shift: 0, band: null };

  let firstChanged = -1;
  let lastChanged = -1;
  for (let r = 0; r < n; r++) {
    if (prev[r] !== next[r]) {
      if (firstChanged === -1) firstChanged = r;
      lastChanged = r;
    }
  }
  if (firstChanged === -1 || lastChanged - firstChanged + 1 < 3) {
    return { shift: 0, band: null };
  }

  const maxShift = Math.max(1, n - 2);
  let bestShift = 0;
  let bestScore = 0;
  let bestBand: ScrollBand | null = null;
  const dirOrder: readonly (1 | -1)[] = preferredDirection < 0 ? [-1, 1] : [1, -1];

  for (let absD = 1; absD <= maxShift; absD++) {
    for (const sign of dirOrder) {
      const d = sign * absD;
      const rStart = d > 0 ? 0 : -d;
      const rEnd = d > 0 ? n - 1 - d : n - 1;
      if (rEnd - rStart + 1 < 2) continue;

      // Kadane's algorithm to locate the best contiguous scrolling run for shift `d`.
      let curScore = 0;
      let curStart = rStart;
      let runScore = 0;
      let runStart = rStart;
      let runEnd = rStart - 1;

      for (let r = rStart; r <= rEnd; r++) {
        const isMatch = prev[r] === next[r + d];
        const w = isMatch ? (prev[r].length > 0 ? 3 : 1) : -6;
        if (curScore <= 0) {
          curScore = w;
          curStart = r;
        } else {
          curScore += w;
        }
        if (curScore > runScore) {
          runScore = curScore;
          runStart = curStart;
          runEnd = r;
        }
      }

      if (runScore <= 0 || runEnd < runStart) continue;

      const runLen = runEnd - runStart + 1;
      let matches = 0;
      let nonEmptyMatches = 0;
      let changedMatches = 0;
      for (let r = runStart; r <= runEnd; r++) {
        if (prev[r] === next[r + d]) {
          matches += 1;
          if (prev[r].length > 0) nonEmptyMatches += 1;
          if (prev[r] !== next[r] || prev[r + d] !== next[r + d]) {
            changedMatches += 1;
          }
        }
      }

      if (matches / runLen < 0.75) continue;
      if (changedMatches < 2) continue;
      if (!(nonEmptyMatches >= 2 || (nonEmptyMatches >= 1 && matches >= 4))) continue;

      const bandTop = d > 0 ? runStart : runStart + d;
      const bandBottom = d > 0 ? runEnd + d : runEnd;

      let sameAtZero = 0;
      for (let r = bandTop; r <= bandBottom; r++) {
        if (prev[r] === next[r] && prev[r].length > 0) {
          sameAtZero += 1;
        }
      }
      if (nonEmptyMatches <= sameAtZero) continue;

      if (
        runScore > bestScore ||
        (runScore === bestScore && Math.abs(d) < Math.abs(bestShift))
      ) {
        bestScore = runScore;
        bestShift = d;
        bestBand = { top: bandTop, bottom: bandBottom };
      }
    }
  }

  return { shift: bestShift, band: bestBand };
}

export function createSelection(
  frame: NativeTermFrameLike,
  startCell: CellPoint,
  endCell: CellPoint = startCell,
  rectangular = false,
): NativeSelectionState {
  const rows = extractFrameRows(frame);
  const lines = new Map<number, StoredRow>();
  for (let r = 0; r < rows.length; r++) {
    lines.set(r, rows[r]);
  }
  return {
    start: { col: startCell.col, docRow: startCell.row },
    end: { col: endCell.col, docRow: endCell.row },
    rectangular,
    viewportTopDocRow: 0,
    lines,
    lastCols: frame.cols,
    lastRows: frame.rows,
    lastDisplayOffset: frame.display_offset,
    lastHistorySize: frame.history_size,
    lastPlainRows: rows.map((r) => r.plain),
    scrollBand: null,
  };
}

function clampCellToScrollBand(sel: NativeSelectionState, cell: CellPoint): CellPoint {
  if (!sel.scrollBand) return cell;
  if (cell.row < sel.scrollBand.top) {
    return { row: sel.scrollBand.top, col: sel.rectangular ? cell.col : 0 };
  }
  if (cell.row > sel.scrollBand.bottom) {
    return { row: sel.scrollBand.bottom, col: sel.rectangular ? cell.col : sel.lastCols };
  }
  return cell;
}

export function updateSelectionEnd(
  sel: NativeSelectionState,
  cell: CellPoint,
): NativeSelectionState {
  const clamped = clampCellToScrollBand(sel, cell);
  return {
    ...sel,
    end: {
      col: clamped.col,
      docRow: sel.viewportTopDocRow + clamped.row,
    },
  };
}

function pruneStoredLines(sel: NativeSelectionState) {
  if (sel.lines.size <= MAX_STORED_LINES) return;
  const minKeep = Math.min(sel.start.docRow, sel.end.docRow, sel.viewportTopDocRow) - 200;
  const maxKeep =
    Math.max(sel.start.docRow, sel.end.docRow, sel.viewportTopDocRow + sel.lastRows) + 200;
  for (const key of sel.lines.keys()) {
    if (key < minKeep || key > maxKeep) {
      sel.lines.delete(key);
      if (sel.lines.size <= MAX_STORED_LINES) break;
    }
  }
}

export function syncSelectionWithFrame(
  sel: NativeSelectionState,
  frame: NativeTermFrameLike,
  opts?: { dragging?: boolean; pointerCell?: CellPoint | null; preferredDirection?: -1 | 0 | 1 },
): NativeSelectionState {
  const nextRows = extractFrameRows(frame);
  const nextPlain = nextRows.map((r) => r.plain);

  // If terminal dimensions changed, refresh visible rows in place without guessing shift.
  if (frame.cols !== sel.lastCols || frame.rows !== sel.lastRows) {
    for (let r = 0; r < nextRows.length; r++) {
      sel.lines.set(sel.viewportTopDocRow + r, nextRows[r]);
    }
    sel.lastCols = frame.cols;
    sel.lastRows = frame.rows;
    sel.lastDisplayOffset = frame.display_offset;
    sel.lastHistorySize = frame.history_size;
    sel.lastPlainRows = nextPlain;
    sel.scrollBand = null;
    if (opts?.dragging && opts.pointerCell) {
      sel.end = {
        col: opts.pointerCell.col,
        docRow: sel.viewportTopDocRow + opts.pointerCell.row,
      };
    }
    return sel;
  }

  let shift = 0;
  let band: ScrollBand | null = null;

  // 1. Exact shift from local alacritty_terminal scrollback metadata when available.
  //    Ignore history_size decreases (e.g. entering alt-screen or \x1b[3J clear scrollback),
  //    which are buffer resets rather than upward scroll shifts.
  if (
    sel.lastHistorySize !== undefined &&
    frame.history_size !== undefined &&
    frame.history_size >= sel.lastHistorySize
  ) {
    const prevTopAbs = sel.lastHistorySize - sel.lastDisplayOffset;
    const nextTopAbs = frame.history_size - frame.display_offset;
    if (prevTopAbs !== nextTopAbs) {
      shift = prevTopAbs - nextTopAbs;
      band = { top: 0, bottom: frame.rows - 1 };
    }
  } else if (sel.lastDisplayOffset !== frame.display_offset) {
    shift = frame.display_offset - sel.lastDisplayOffset;
    band = { top: 0, bottom: frame.rows - 1 };
  }

  // 2. Fallback to content-overlap scroll detection for remote-scrolled sessions
  //    (pty-daemon scrollback, Claude Code, tmux, vim, or local history cap).
  if (shift === 0) {
    const detected = detectScrollShift(
      sel.lastPlainRows,
      nextPlain,
      opts?.preferredDirection ?? 0,
    );
    shift = detected.shift;
    band = detected.band;
  }

  if (shift !== 0) {
    sel.viewportTopDocRow -= shift;
    if (band) {
      if (band.top > 0 || band.bottom < frame.rows - 1) {
        sel.scrollBand = band;
      } else {
        sel.scrollBand = null;
      }
    }
  }

  const writeTop = sel.scrollBand ? sel.scrollBand.top : 0;
  const writeBottom = sel.scrollBand ? sel.scrollBand.bottom : frame.rows - 1;
  for (let r = writeTop; r <= writeBottom && r < nextRows.length; r++) {
    sel.lines.set(sel.viewportTopDocRow + r, nextRows[r]);
  }

  sel.lastDisplayOffset = frame.display_offset;
  sel.lastHistorySize = frame.history_size;
  sel.lastPlainRows = nextPlain;

  if (opts?.dragging && opts.pointerCell) {
    const clamped = clampCellToScrollBand(sel, opts.pointerCell);
    sel.end = {
      col: clamped.col,
      docRow: sel.viewportTopDocRow + clamped.row,
    };
  }

  pruneStoredLines(sel);
  return sel;
}

export function getVisibleSelectionRanges(
  sel: NativeSelectionState,
  cols: number,
  rows: number,
): VisibleSelectionRow[] {
  const startVisRow = sel.start.docRow - sel.viewportTopDocRow;
  const endVisRow = sel.end.docRow - sel.viewportTopDocRow;
  const minVisRow = sel.scrollBand ? sel.scrollBand.top : 0;
  const maxVisRow = sel.scrollBand ? Math.min(rows - 1, sel.scrollBand.bottom) : rows - 1;

  const out: VisibleSelectionRow[] = [];

  if (sel.rectangular) {
    const r0 = Math.max(minVisRow, Math.min(startVisRow, endVisRow));
    const r1 = Math.min(maxVisRow, Math.max(startVisRow, endVisRow));
    const c0 = Math.min(sel.start.col, sel.end.col);
    const c1 = Math.max(sel.start.col, sel.end.col);
    if (c1 > c0) {
      for (let r = r0; r <= r1; r++) {
        out.push({ row: r, startCol: c0, endCol: c1 });
      }
    }
    return out;
  }

  const [a, b] =
    sel.start.docRow < sel.end.docRow ||
    (sel.start.docRow === sel.end.docRow && sel.start.col <= sel.end.col)
      ? [sel.start, sel.end]
      : [sel.end, sel.start];

  const aVis = a.docRow - sel.viewportTopDocRow;
  const bVis = b.docRow - sel.viewportTopDocRow;
  const r0 = Math.max(minVisRow, aVis);
  const r1 = Math.min(maxVisRow, bVis);

  for (let r = r0; r <= r1; r++) {
    const c0 = r === aVis ? a.col : 0;
    const c1 = r === bVis ? b.col : cols;
    if (c1 > c0) {
      out.push({ row: r, startCol: c0, endCol: c1 });
    }
  }
  return out;
}

export function extractSelectionText(sel: NativeSelectionState): string {
  const [a, b] =
    sel.start.docRow < sel.end.docRow ||
    (sel.start.docRow === sel.end.docRow && sel.start.col <= sel.end.col)
      ? [sel.start, sel.end]
      : [sel.end, sel.start];

  if (a.docRow === b.docRow && a.col === b.col) return "";

  const rectC0 = Math.min(sel.start.col, sel.end.col);
  const rectC1 = Math.max(sel.start.col, sel.end.col);
  let out = "";

  for (let docRow = a.docRow; docRow <= b.docRow; docRow++) {
    const stored = sel.lines.get(docRow);
    if (!stored) {
      if (docRow < b.docRow) out += "\n";
      continue;
    }
    const cols = stored.chars.length;
    const c0 = sel.rectangular ? rectC0 : docRow === a.docRow ? a.col : 0;
    const c1 = sel.rectangular ? rectC1 : docRow === b.docRow ? b.col : cols;
    const isSoftWrapped =
      !sel.rectangular && docRow < b.docRow && stored.wrapped && c1 >= cols;
    const chunk = stored.chars.slice(c0, c1).join("");
    out += isSoftWrapped ? chunk : chunk.trimEnd();
    if (docRow < b.docRow && !isSoftWrapped) {
      out += "\n";
    }
  }

  return out.trimEnd();
}
