// Pure models for the Finder-like file manager: selection, sort, history,
// clipboard, names, per-machine prefs and transfer orchestration.
import type { DirEntry } from "@offdesk/shared";
import { RemoteFileError } from "./api";
import type { FsConflictPolicy, RemoteRange } from "./api";
import { classifyListError } from "./fileBrowser";
import { arrayBufferToBase64 } from "./terminalImagePaste";
import { UPLOAD_CHUNK_BYTES } from "./terminalUpload";

export { UPLOAD_CHUNK_BYTES };
export const DOWNLOAD_CHUNK_BYTES = 4 * 1024 * 1024;

// ---------------------------------------------------------------- names

/** Mirrors the node: non-empty, no `/`, not `.`/`..`, no NUL. Null when valid. */
export function validateName(name: string): string | null {
  if (name.length === 0) return "Name cannot be empty";
  if (name === "." || name === "..") return "That name is reserved";
  if (name.includes("/")) return "Name cannot contain “/”";
  if (name.includes("\0")) return "Name contains an invalid character";
  return null;
}

export function joinPath(dir: string, name: string): string {
  if (dir === "" || dir === ".") return name;
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

function trimSlashes(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") || "/" : path;
}

export function basename(path: string): string {
  const p = trimSlashes(path);
  if (p === "/") return "/";
  return p.slice(p.lastIndexOf("/") + 1);
}

/** Parent of `path`: "/" for top-level, "~" for "~/x", "" when there is no slash. */
export function dirname(path: string): string {
  const p = trimSlashes(path);
  if (p === "/" || p === "~") return p;
  const idx = p.lastIndexOf("/");
  if (idx < 0) return "";
  if (idx === 0) return "/";
  return p.slice(0, idx);
}

// ---------------------------------------------------------------- sort

export type SortKey = "name" | "size" | "modified" | "kind";
export type SortDir = "asc" | "desc";
export interface SortSpec {
  key: SortKey;
  dir: SortDir;
}

/** "folder" for directories, else the lowercase extension ("" if none). */
export function entryKind(entry: DirEntry): string {
  if (entry.is_dir) return "folder";
  const idx = entry.name.lastIndexOf(".");
  return idx > 0 ? entry.name.slice(idx + 1).toLowerCase() : "";
}

const compareNames = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }) ||
  (a < b ? -1 : a > b ? 1 : 0);

/** Folders always first; ties on the key fall back to ascending name. */
export function sortEntries(entries: DirEntry[], spec: SortSpec): DirEntry[] {
  const sign = spec.dir === "asc" ? 1 : -1;
  const byKey = (a: DirEntry, b: DirEntry): number => {
    switch (spec.key) {
      case "name":
        return compareNames(a.name, b.name);
      case "size":
        return (a.size ?? -1) - (b.size ?? -1);
      case "modified":
        return (a.modified_ms ?? 0) - (b.modified_ms ?? 0);
      case "kind":
        return compareNames(entryKind(a), entryKind(b));
    }
  };
  return [...entries].sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    const primary = byKey(a, b);
    if (primary !== 0) return primary * sign;
    return spec.key === "name" ? 0 : compareNames(a.name, b.name);
  });
}

// ---------------------------------------------------------------- selection

export interface Selection {
  selected: Set<string>;
  anchor: string | null;
  focus: string | null;
}

export const emptySelection = (): Selection => ({ selected: new Set(), anchor: null, focus: null });

/** Plain click: replace the selection. */
export function selectOne(_state: Selection, path: string): Selection {
  return { selected: new Set([path]), anchor: path, focus: path };
}

/** ⌘/Ctrl click: toggle one item; it becomes the anchor. */
export function toggleSelect(state: Selection, path: string): Selection {
  const selected = new Set(state.selected);
  if (selected.has(path)) selected.delete(path);
  else selected.add(path);
  return { selected, anchor: path, focus: path };
}

function rangeBetween(order: string[], a: string, b: string): string[] {
  const i = order.indexOf(a);
  const j = order.indexOf(b);
  if (i < 0 || j < 0) return [b];
  return order.slice(Math.min(i, j), Math.max(i, j) + 1);
}

/** Shift click: select anchor..path (replacing); the anchor stays put. */
export function selectRange(state: Selection, order: string[], path: string): Selection {
  const anchor = state.anchor !== null && order.includes(state.anchor) ? state.anchor : path;
  return { selected: new Set(rangeBetween(order, anchor, path)), anchor, focus: path };
}

export function selectAll(state: Selection, order: string[]): Selection {
  if (order.length === 0) return state;
  const anchor = state.anchor !== null && order.includes(state.anchor) ? state.anchor : order[0];
  const focus = state.focus !== null && order.includes(state.focus) ? state.focus : order[order.length - 1];
  return { selected: new Set(order), anchor, focus };
}

/**
 * Arrow key: move focus by `delta` rows (clamped). Without `extend` the focused
 * row becomes the sole selection; with it, the range anchor..focus is selected.
 * With no focus yet, down goes to the first row and up to the last.
 */
export function moveFocus(
  state: Selection,
  order: string[],
  delta: number,
  extend = false,
): Selection {
  if (order.length === 0) return state;
  const cur = state.focus !== null ? order.indexOf(state.focus) : -1;
  let next: number;
  if (cur < 0) next = delta >= 0 ? 0 : order.length - 1;
  else next = Math.min(order.length - 1, Math.max(0, cur + delta));
  const path = order[next];
  if (!extend) return selectOne(state, path);
  const anchor =
    state.anchor !== null && order.includes(state.anchor)
      ? state.anchor
      : cur >= 0
        ? order[cur]
        : path;
  return { selected: new Set(rangeBetween(order, anchor, path)), anchor, focus: path };
}

/** Drops paths that are no longer listed. Returns the same object if unchanged. */
export function pruneSelection(state: Selection, order: string[]): Selection {
  const present = new Set(order);
  const selected = new Set([...state.selected].filter((p) => present.has(p)));
  const anchor = state.anchor !== null && present.has(state.anchor) ? state.anchor : null;
  const focus = state.focus !== null && present.has(state.focus) ? state.focus : null;
  if (selected.size === state.selected.size && anchor === state.anchor && focus === state.focus) {
    return state;
  }
  return { selected, anchor, focus };
}

/** Selected paths in listing order. */
export function selectedPaths(state: Selection, order: string[]): string[] {
  return order.filter((p) => state.selected.has(p));
}

// ---------------------------------------------------------------- history

export interface History {
  stack: string[];
  index: number;
}

export const createHistory = (path: string): History => ({ stack: [path], index: 0 });
export const historyCurrent = (h: History): string => h.stack[h.index];
export const canBack = (h: History): boolean => h.index > 0;
export const canForward = (h: History): boolean => h.index < h.stack.length - 1;

/** Visit `path`, dropping any forward entries. Same path as current is a no-op. */
export function historyPush(h: History, path: string): History {
  if (historyCurrent(h) === path) return h;
  return { stack: [...h.stack.slice(0, h.index + 1), path], index: h.index + 1 };
}
export const historyBack = (h: History): History => (canBack(h) ? { ...h, index: h.index - 1 } : h);
export const historyForward = (h: History): History =>
  canForward(h) ? { ...h, index: h.index + 1 } : h;

// ---------------------------------------------------------------- clipboard

export interface FileClipboard {
  mode: "copy" | "cut";
  machineId: string;
  paths: string[];
}

export type PasteDecision =
  | { ok: true; op: "copy" | "move" }
  | { ok: false; reason: string };

export function pasteDecision(
  clip: FileClipboard | null,
  machineId: string,
  destDir: string,
): PasteDecision {
  if (!clip || clip.paths.length === 0) return { ok: false, reason: "Nothing to paste" };
  if (clip.machineId !== machineId) {
    return { ok: false, reason: "Pasting between machines is not supported" };
  }
  const dest = trimSlashes(destDir);
  if (clip.mode === "cut") {
    if (clip.paths.every((p) => dirname(p) === dest)) {
      return { ok: false, reason: "Already in this folder" };
    }
  }
  for (const p of clip.paths) {
    const src = trimSlashes(p);
    if (dest === src || dest.startsWith(`${src}/`)) {
      return { ok: false, reason: `Cannot put “${basename(src)}” inside itself` };
    }
  }
  return { ok: true, op: clip.mode === "copy" ? "copy" : "move" };
}

/** Clipboard after a successful paste: cut is consumed, copy stays. */
export function clipboardAfterPaste(clip: FileClipboard): FileClipboard | null {
  return clip.mode === "cut" ? null : clip;
}

// ---------------------------------------------------------------- prefs

const PINNED_KEY = "offdesk.files.pinned.";
const VIEW_KEY = "offdesk.files.view.";

export interface ViewPrefs {
  view: "list" | "icons";
  sort: SortSpec;
}
export const DEFAULT_VIEW_PREFS: ViewPrefs = { view: "list", sort: { key: "name", dir: "asc" } };

// In-memory fallback for when localStorage is missing or throws.
const memory = new Map<string, string>();

function readStore(key: string): string | null {
  try {
    const v = globalThis.localStorage?.getItem(key);
    if (v != null) return v;
  } catch {
    // fall through to memory
  }
  return memory.get(key) ?? null;
}

function writeStore(key: string, value: string): void {
  memory.set(key, value);
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // memory copy is enough for this session
  }
}

export function pinnedFolders(machineId: string): string[] {
  const raw = readStore(PINNED_KEY + machineId);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

export function pinFolder(machineId: string, path: string): string[] {
  const list = pinnedFolders(machineId);
  if (list.includes(path)) return list;
  const next = [...list, path];
  writeStore(PINNED_KEY + machineId, JSON.stringify(next));
  return next;
}

export function unpinFolder(machineId: string, path: string): string[] {
  const next = pinnedFolders(machineId).filter((p) => p !== path);
  writeStore(PINNED_KEY + machineId, JSON.stringify(next));
  return next;
}

const SORT_KEYS: SortKey[] = ["name", "size", "modified", "kind"];

export function viewPrefs(machineId: string): ViewPrefs {
  const raw = readStore(VIEW_KEY + machineId);
  if (!raw) return DEFAULT_VIEW_PREFS;
  try {
    const p = JSON.parse(raw) as Partial<ViewPrefs> | null;
    const key = p?.sort?.key;
    const dir = p?.sort?.dir;
    return {
      view: p?.view === "icons" ? "icons" : "list",
      sort: {
        key: key && SORT_KEYS.includes(key) ? key : "name",
        dir: dir === "desc" ? "desc" : "asc",
      },
    };
  } catch {
    return DEFAULT_VIEW_PREFS;
  }
}

export function setViewPrefs(machineId: string, prefs: ViewPrefs): void {
  writeStore(VIEW_KEY + machineId, JSON.stringify(prefs));
}

// ---------------------------------------------------------------- errors

/** User-facing text for a failed file operation. `name` overrides the item shown. */
export function describeFsOpError(err: unknown, name?: string): string {
  if (err instanceof RemoteFileError) {
    const item = name ?? (err.path ? basename(err.path) : undefined);
    switch (err.code) {
      case "exists":
        return item
          ? `An item named “${item}” already exists`
          : "An item with that name already exists";
      case "machine_outdated":
        return "Update this machine to manage files";
      case "permission_denied":
        return item ? `No permission to change ${item}` : "No permission to do that";
      case "no_space":
        return "Not enough free space on the machine";
      case "invalid":
        return err.message || "That name or location is not valid";
      case "not_found":
        return item ? `${item} no longer exists` : "That item no longer exists";
      case "too_large":
        return "That file is too large";
      case "machine_not_found":
        return "Machine not found";
      case "machine_disconnected":
      case "timeout":
        return "The machine is offline or not responding";
    }
  }
  if (classifyListError(err) === "offline") return "The machine is offline or not responding";
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------- transfers

export interface UploadApi {
  uploadBegin: (
    machineId: string,
    body: { dest_dir: string; filename: string; size: number; on_conflict: FsConflictPolicy },
    signal?: AbortSignal,
  ) => Promise<{ upload_id: string }>;
  uploadChunk: (
    machineId: string,
    uploadId: string,
    index: number,
    dataBase64: string,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  uploadEnd: (
    machineId: string,
    uploadId: string,
    signal?: AbortSignal,
  ) => Promise<{ path: string; size: number }>;
  uploadAbort: (machineId: string, uploadId: string) => Promise<unknown>;
}

export interface DownloadApi {
  readRange: (
    machineId: string,
    path: string,
    offset: number,
    length: number,
    signal?: AbortSignal,
  ) => Promise<RemoteRange>;
  zipPaths: (
    machineId: string,
    paths: string[],
    signal?: AbortSignal,
  ) => Promise<{ path: string; size: number; name: string }>;
}

function abortError(): Error {
  const err = new Error("Aborted");
  err.name = "AbortError";
  return err;
}

export const isAbortError = (err: unknown): boolean =>
  err instanceof Error && err.name === "AbortError";

export interface UploadOptions {
  machineId: string;
  destDir: string;
  file: Blob & { name?: string };
  onConflict: FsConflictPolicy;
  onProgress?: (sent: number, total: number) => void;
  signal?: AbortSignal;
  api: UploadApi;
  chunkBytes?: number;
}

/** Uploads one file into `destDir`; removes the part file on error or abort. */
export async function uploadToDirectory(opts: UploadOptions): Promise<{ path: string; size: number }> {
  const { machineId, destDir, file, onConflict, onProgress, signal, api } = opts;
  const chunkBytes = opts.chunkBytes ?? UPLOAD_CHUNK_BYTES;
  const total = file.size;
  if (signal?.aborted) throw abortError();
  const { upload_id: id } = await api.uploadBegin(
    machineId,
    { dest_dir: destDir, filename: file.name || "upload", size: total, on_conflict: onConflict },
    signal,
  );
  try {
    let index = 0;
    for (let offset = 0; offset < total; offset += chunkBytes, index++) {
      if (signal?.aborted) throw abortError();
      const buffer = await file.slice(offset, Math.min(offset + chunkBytes, total)).arrayBuffer();
      await api.uploadChunk(machineId, id, index, arrayBufferToBase64(buffer), signal);
      onProgress?.(Math.min(offset + chunkBytes, total), total);
    }
    if (signal?.aborted) throw abortError();
    const result = await api.uploadEnd(machineId, id, signal);
    onProgress?.(total, total);
    return result;
  } catch (err) {
    try {
      await api.uploadAbort(machineId, id);
    } catch {
      // the node drops idle uploads on its own
    }
    throw err;
  }
}

function decodeBase64(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export interface DownloadOptions {
  machineId: string;
  path: string;
  /** Expected size, used for progress until the node reports the real one. */
  size: number;
  onProgress?: (received: number, total: number) => void;
  signal?: AbortSignal;
  api: Pick<DownloadApi, "readRange">;
  chunkBytes?: number;
}

/** Pulls a remote file in 4 MiB ranges into a Blob. */
export async function downloadRemote(opts: DownloadOptions): Promise<Blob> {
  const { machineId, path, onProgress, signal, api } = opts;
  const chunkBytes = opts.chunkBytes ?? DOWNLOAD_CHUNK_BYTES;
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let total = opts.size;
  let offset = 0;
  for (;;) {
    if (signal?.aborted) throw abortError();
    const res = await api.readRange(machineId, path, offset, chunkBytes, signal);
    const bytes = decodeBase64(res.data_base64);
    if (bytes.length > 0) parts.push(bytes);
    offset += bytes.length;
    total = res.size;
    onProgress?.(offset, total);
    if (res.eof) break;
    // A non-final empty chunk would loop forever.
    if (bytes.length === 0) throw new Error("The machine returned no data before the end of the file");
  }
  return new Blob(parts, { type: "application/octet-stream" });
}

/** Zips `paths` on the machine, then pulls the zip. `filename` ends in ".zip". */
export async function downloadZip(opts: {
  machineId: string;
  paths: string[];
  onProgress?: (received: number, total: number) => void;
  signal?: AbortSignal;
  api: DownloadApi;
}): Promise<{ blob: Blob; filename: string }> {
  const { machineId, paths, onProgress, signal, api } = opts;
  const zip = await api.zipPaths(machineId, paths, signal);
  const blob = await downloadRemote({
    machineId,
    path: zip.path,
    size: zip.size,
    onProgress,
    signal,
    api,
  });
  const filename = /\.zip$/i.test(zip.name) ? zip.name : `${zip.name}.zip`;
  return { blob, filename };
}

/**
 * Base64 of a Blob for `saveDownloadedFile` / `saveFetchedFile`, encoded in
 * slices (a multiple of 3 bytes, so the pieces concatenate cleanly).
 */
export async function blobToBase64(blob: Blob): Promise<string> {
  const slice = 3 * 256 * 1024;
  let out = "";
  for (let offset = 0; offset < blob.size; offset += slice) {
    out += arrayBufferToBase64(await blob.slice(offset, offset + slice).arrayBuffer());
  }
  return out;
}
