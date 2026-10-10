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
 */
function appWrap(prev: RawRow, next: RawRow, indent: number, cols: number): string | null {
  const body = next.text.trimStart();
  const lead = next.text.length - body.length;
  if (!body || lead === 0 || lead !== indent || !prev.text.trim()) return null;
  const firstEnd = body.search(/\s/);
  const first = span(next, lead, firstEnd < 0 ? next.text.length : lead + firstEnd);
  const prevWidth = prev.width ?? prev.text.length;
  if (prevWidth >= cols) {
    const last = span(prev, prev.text.search(/\S+$/), prev.text.length);
    return last + first > cols - lead ? "" : " ";
  }
  return prevWidth + 1 + first > cols ? " " : null;
}

// Collapse wrapped rows back into logical lines, so the user doesn't paste
// artificial mid-sentence newlines (or a command broken in pieces) into a
// shell, chat or docs. xterm marks its own soft wraps with isWrapped; with
// `cols`, rows an app such as Claude Code wrapped itself are joined too.
export function mergeWrappedRows(rows: RawRow[], cols = Infinity): string[] {
  const merged: string[] = [];
  let prev: RawRow | null = null;
  let indent = 0;
  for (const row of rows) {
    const last = merged.length - 1;
    if (prev && row.isWrapped) {
      merged[last] += row.text;
      prev = row;
      continue;
    }
    const join = prev ? appWrap(prev, row, indent, cols) : null;
    if (join !== null) {
      merged[last] += join + row.text.trimStart();
      prev = row;
      continue;
    }
    merged.push(row.text);
    prev = row;
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
