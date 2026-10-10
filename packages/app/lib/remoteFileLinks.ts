// Pure helpers for turning terminal output into "fetch this remote file"
// links: OSC 8 `file://` URIs (what `offdesk fetch` and `ls --hyperlink`
// print) and bare paths found in plain output.

/**
 * Pseudo-URI that carries a bare-path match through code that only passes
 * link *strings* around (xterm hover/leave bookkeeping, tap activation).
 * Never leaves the app.
 */
const PATH_LINK_PREFIX = "offdesk-path:";

/** Absolute path from an OSC 8 `file://<host>/<path>` URI; host is ignored. */
export function parseFileUri(uri: string): string | null {
  const match = /^file:\/\/[^/?#]*(\/[^?#]*)/i.exec(uri.trim());
  if (!match) return null;
  let path: string;
  try {
    path = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  if (path.includes("\0")) return null;
  return path;
}

/** A path a terminal link names, and what to try if it does not exist. */
export interface RemotePathLink {
  path: string;
  fallback?: string;
}

/** The fallback rides after a space, which encodeURIComponent never emits. */
export function pathLinkUri(path: string, fallback?: string): string {
  const uri = PATH_LINK_PREFIX + encodeURIComponent(path);
  return fallback ? `${uri} ${encodeURIComponent(fallback)}` : uri;
}

export function parsePathLinkUri(uri: string): RemotePathLink | null {
  if (!uri.startsWith(PATH_LINK_PREFIX)) return null;
  const [path, fallback] = uri.slice(PATH_LINK_PREFIX.length).split(" ");
  try {
    return fallback
      ? { path: decodeURIComponent(path), fallback: decodeURIComponent(fallback) }
      : { path: decodeURIComponent(path) };
  } catch {
    return null;
  }
}

/** A remote path reference carried by a terminal link, if the URI is one. */
export function remotePathFromLink(uri: string): RemotePathLink | null {
  const file = parseFileUri(uri);
  return file !== null ? { path: file } : parsePathLinkUri(uri);
}

export interface PathMatch {
  /** Index of the first char of the path in the line (UTF-16). */
  start: number;
  /** Index one past the last char of the path. */
  end: number;
  /** The path as written (no `:line:col` suffix, no trailing punctuation). */
  path: string;
}

const SEG = String.raw`[\p{L}\p{N}_.@%+~=-]+`;
// Not preceded by anything that makes this a fragment of a URL, a word or a
// longer path (`a/b/c` must not match as `/b/c`, `host:80/x` not as `/x`).
const BEFORE = String.raw`(?<![\p{L}\p{N}_.@%+~:/-])`;
const ROOT_RE = new RegExp(
  `${BEFORE}(?:~\\/${SEG}(?:\\/${SEG})*\\/?|\\.{1,2}\\/${SEG}(?:\\/${SEG})*\\/?|(?:\\/${SEG}){2,}\\/?)`,
  "gu",
);

/** Finds absolute, `~/` and `./` / `../` paths in one line of output. */
export function findPathsInLine(line: string): PathMatch[] {
  const out: PathMatch[] = [];
  ROOT_RE.lastIndex = 0;
  for (let m = ROOT_RE.exec(line); m; m = ROOT_RE.exec(line)) {
    let text = m[0];
    // Sentence punctuation that is legal inside a name but not at its end.
    text = text.replace(/[.,;=+%@-]+$/, "");
    // `~/x` -> keep; a bare `./` or `../` or `~/` with no name is noise.
    // Nothing but dots, slashes and `~` is noise, not a file.
    if (/^[./~]+$/.test(text)) continue;
    out.push({ start: m.index, end: m.index + text.length, path: text });
  }
  return out;
}

/** One terminal row, as read by {@link lineTextWithColumns}. */
export interface TerminalRow {
  text: string;
  columns: number[];
  /** The last cell is written: the text runs into the right edge. */
  full: boolean;
  /** The terminal itself wrapped the row above onto this one. */
  wrapped: boolean;
}

export interface CellPosition {
  row: number;
  column: number;
}

export interface RowPathMatch {
  path: string;
  /** Cell of the first character. */
  start: CellPosition;
  /** Cell of the last character. */
  end: CellPosition;
  /** For a path joined across rows: the part on its first row alone. */
  fallback?: string;
}

// The text ends inside a path that may go on: a path start at a word
// boundary followed only by path characters.
const OPEN_PATH_TAIL = new RegExp(
  `${BEFORE}(?:~|\\.{1,2})?\\/[\\p{L}\\p{N}_.@%+~=/-]*$`,
  "u",
);
const CONTINUES_PATH = /^\s*[\p{L}\p{N}_.@%+~=/-]/u;
const MAX_JOINED_ROWS = 8;

/**
 * Paths that touch `row`, including ones split over several rows. The
 * terminal marks its own soft wraps, but full-screen apps such as Claude
 * Code break long words themselves: the row is filled to the right edge and
 * the rest goes on the next row after the item's indent, with nothing in
 * the buffer saying the two belong together. So a path that runs into the
 * edge continues on the next row when that row (past its indent) starts
 * with path characters.
 *
 * A path that merely ends at the edge is then joined to the next row's
 * first word, so a joined match carries its first-row part as `fallback`.
 */
export function findPathsAcrossRows(
  readRow: (row: number) => TerminalRow | undefined,
  row: number,
): RowPathMatch[] {
  const cache = new Map<number, TerminalRow | undefined>();
  const getRow = (r: number) => {
    if (!cache.has(r)) cache.set(r, readRow(r));
    return cache.get(r);
  };
  if (!getRow(row)) return [];

  // How far up the logical line containing `row` could begin.
  let first = row;
  while (row - first < MAX_JOINED_ROWS) {
    const above = getRow(first - 1);
    const here = getRow(first)!;
    if (!above || !(here.wrapped || (above.full && CONTINUES_PATH.test(here.text)))) break;
    first--;
  }

  // Join forward from there. A piece maps text[base…] to its row's
  // text[from…]; rows that do not continue start a new logical line.
  let pieces: { row: number; from: number; base: number }[] = [];
  let text = "";
  for (let r = first; r <= row + MAX_JOINED_ROWS; r++) {
    const current = getRow(r);
    if (!current) break;
    const above = getRow(r - 1);
    const joins =
      r > first &&
      above !== undefined &&
      (current.wrapped ||
        (above.full && OPEN_PATH_TAIL.test(text) && CONTINUES_PATH.test(current.text)));
    if (joins) {
      const from = current.wrapped ? 0 : current.text.length - current.text.trimStart().length;
      pieces.push({ row: r, from, base: text.length });
      text += current.text.slice(from);
    } else if (r <= row) {
      pieces = [{ row: r, from: 0, base: 0 }];
      text = current.text;
    } else {
      break;
    }
  }

  const pieceAt = (index: number) => {
    let found = 0;
    while (found + 1 < pieces.length && pieces[found + 1].base <= index) found++;
    return found;
  };
  const cellAt = (index: number): CellPosition => {
    const piece = pieces[pieceAt(index)];
    return {
      row: piece.row,
      column: getRow(piece.row)!.columns[piece.from + index - piece.base],
    };
  };

  const out: RowPathMatch[] = [];
  for (const m of findPathsInLine(text)) {
    const start = cellAt(m.start);
    const end = cellAt(m.end - 1);
    if (start.row > row || end.row < row) continue;
    const match: RowPathMatch = { path: m.path, start, end };
    if (start.row !== end.row) {
      const head = text.slice(m.start, pieces[pieceAt(m.start) + 1].base);
      const [alone] = findPathsInLine(head);
      if (alone && alone.start === 0 && alone.path !== m.path) match.fallback = alone.path;
    }
    out.push(match);
  }
  return out;
}

/**
 * Resolves a path against the terminal's cwd into an absolute POSIX path.
 * `~` paths are returned untouched (only the machine knows its home).
 * Returns null for a relative path with no cwd.
 */
export function resolveRemotePath(path: string, cwd?: string | null): string | null {
  if (path.startsWith("~")) return path;
  let full = path;
  if (!path.startsWith("/")) {
    if (!cwd || !cwd.startsWith("/")) return null;
    full = `${cwd.replace(/\/+$/, "")}/${path}`;
  }
  const parts: string[] = [];
  for (const part of full.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  const trailing = full.endsWith("/") && parts.length > 0 ? "/" : "";
  return `/${parts.join("/")}${trailing}`;
}

export interface CellLineLike {
  length: number;
  getCell(
    x: number,
  ): { getChars(): string; getWidth(): number } | undefined;
}

/**
 * Line text plus the terminal column (0-based) of each UTF-16 index, so
 * matches stay correctly placed after wide (CJK) or combining characters,
 * and whether the text runs into the last column.
 */
export function lineTextWithColumns(line: CellLineLike): {
  text: string;
  columns: number[];
  full: boolean;
} {
  let text = "";
  const columns: number[] = [];
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x);
    if (!cell) continue;
    const width = cell.getWidth();
    if (width === 0) continue; // trailing half of a wide char
    const chars = cell.getChars() || " ";
    for (let i = 0; i < chars.length; i++) columns.push(x);
    text += chars;
  }
  const last = line.getCell(line.length - 1);
  // A zero-width last cell is the trailing half of a wide character.
  const full = !!last && (last.getWidth() === 0 || /\S/.test(last.getChars()));
  return { text, columns, full };
}

/** Last path segment, for messages. */
export function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) || trimmed : trimmed;
}
