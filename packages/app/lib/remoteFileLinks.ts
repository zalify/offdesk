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

export function pathLinkUri(path: string): string {
  return PATH_LINK_PREFIX + encodeURIComponent(path);
}

export function parsePathLinkUri(uri: string): string | null {
  if (!uri.startsWith(PATH_LINK_PREFIX)) return null;
  try {
    return decodeURIComponent(uri.slice(PATH_LINK_PREFIX.length));
  } catch {
    return null;
  }
}

/** A remote path reference carried by a terminal link, if the URI is one. */
export function remotePathFromLink(uri: string): string | null {
  return parseFileUri(uri) ?? parsePathLinkUri(uri);
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
 * matches stay correctly placed after wide (CJK) or combining characters.
 */
export function lineTextWithColumns(line: CellLineLike): {
  text: string;
  columns: number[];
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
  return { text, columns };
}

/** Last path segment, for messages. */
export function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) || trimmed : trimmed;
}
