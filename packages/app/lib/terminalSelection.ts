// Helpers for the mobile select-mode overlay. Pure utilities so the
// wrap-merging logic is testable without a real xterm instance.

export interface RawRow {
  text: string;
  /** True when this terminal row is the soft-wrap continuation of the previous row. */
  isWrapped: boolean;
  /** Terminal column of each UTF-16 index of `text`; one column each when absent. */
  columns?: number[];
  /** Columns `text` spans (wide characters take two); its length when absent. */
  width?: number;
}

// A list or tool-output marker whose text the item's next rows line up with.
const ITEM_MARKER = /^(?:[-*+•●◦▪⎿>]|\d+[.)])\s+/u;

const columnAt = (row: RawRow, index: number) =>
  index < row.text.length ? (row.columns?.[index] ?? index) : (row.width ?? row.text.length);
const span = (row: RawRow, start: number, end: number) => columnAt(row, end) - columnAt(row, start);

/**
 * How `next` continues the logical line that `prev` ends, if it does: "" to
 * join a word broken in two, " " to join at a word wrap, null for a real
 * line break.
 *
 * Full-screen apps such as Claude Code wrap paragraphs themselves: the rest
 * goes on the next row after the item's indent, and a word is only broken
 * where it is longer than a whole row. So a row continues the one above when
 * it starts at the paragraph's indent and either the row above is full, or
 * its first word would not have fitted there. A full row above is a broken
 * word only when the two halves together are longer than a row; otherwise
 * the row just filled up at a space.
 *
 * When a row fills up exactly, Claude Code puts the space before the next
 * word at the start of the next row and doesn't draw it, so that row
 * (`shifted`) holds one column less: it is full one column short of the
 * edge. So a row below a full one that is a single word ending one column
 * short of the edge started a new word there.
 */
function appWrap(
  prev: RawRow,
  next: RawRow,
  indent: number,
  cols: number,
  shifted: boolean,
): string | null {
  const body = next.text.trimStart();
  const lead = next.text.length - body.length;
  if (!body || lead === 0 || lead !== indent || !prev.text.trim()) return null;
  const firstEnd = body.search(/\s/);
  const first = span(next, lead, firstEnd < 0 ? next.text.length : lead + firstEnd);
  const prevWidth = rowWidth(prev, shifted);
  if (prevWidth >= cols) {
    if (firstEnd < 0 && rowWidth(next, false) === cols - 1) return " ";
    const last = span(prev, prev.text.search(/\S+$/), prev.text.length);
    return last + first > cols - lead ? "" : " ";
  }
  return prevWidth + 1 + first > cols ? " " : null;
}

// Columns a row's text takes, counting the undrawn space a shifted row starts with.
const rowWidth = (row: RawRow, shifted: boolean) =>
  (row.width ?? row.text.length) + (shifted ? 1 : 0);

// Collapse wrapped rows back into logical lines, so the user doesn't paste
// artificial mid-sentence newlines (or a command broken in pieces) into a
// shell, chat or docs. xterm marks its own soft wraps with isWrapped; with
// `cols`, rows an app such as Claude Code wrapped itself are joined too.
export function mergeWrappedRows(rows: RawRow[], cols = Infinity): string[] {
  const merged: string[] = [];
  let prev: RawRow | null = null;
  let shifted = false;
  let indent = 0;
  for (const row of rows) {
    const last = merged.length - 1;
    if (prev && row.isWrapped) {
      merged[last] += row.text;
      prev = row;
      shifted = false;
      continue;
    }
    const join: string | null = prev ? appWrap(prev, row, indent, cols, shifted) : null;
    if (join !== null) {
      merged[last] += join + row.text.trimStart();
      shifted = join === " " && rowWidth(prev!, shifted) >= cols;
      prev = row;
      continue;
    }
    merged.push(row.text);
    prev = row;
    shifted = false;
    const lead = row.text.length - row.text.trimStart().length;
    indent = lead + (ITEM_MARKER.exec(row.text.slice(lead))?.[0].length ?? 0);
  }
  return merged;
}

// Drop trailing rows that are fully blank so the overlay doesn't render
// a tall expanse of empty lines below the actual content.
export function trimTrailingBlankLines(lines: string[]): string[] {
  const out = [...lines];
  while (out.length > 0 && out[out.length - 1].trim() === "") {
    out.pop();
  }
  return out;
}
