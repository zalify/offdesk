// Previewing an HTML file of a remote machine as a web page. The app shows it
// in a native WebView of its own (see nativeHtmlPreview.ts); every request
// that page makes comes back here as an absolute path on the machine, and is
// answered from the machine's files.

import type { DirEntry } from "@offdesk/shared";
import type { RemoteFile } from "./api";
import { RemoteFileError } from "./api";
import { base64ToBytes, extensionOf } from "./filePreview";

export interface PreviewResponse {
  status: number;
  mime: string;
  dataBase64: string;
}

const HTML_EXTS = new Set(["html", "htm"]);

export function isHtmlFile(name: string): boolean {
  return HTML_EXTS.has(extensionOf(name));
}

const MIME_BY_EXT: Record<string, string> = {
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  json: "application/json",
  map: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  wasm: "application/wasm",
  txt: "text/plain",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  pdf: "application/pdf",
};

// Module scripts and stylesheets are refused under a wrong type, so the
// extension wins over what the machine guessed.
export function previewMime(name: string, mime: string): string {
  return MIME_BY_EXT[extensionOf(name)] ?? (mime || "application/octet-stream");
}

const REWRITTEN = new Set(["text/html", "text/css", "text/javascript", "image/svg+xml"]);

/**
 * `file:///Users/a/b.css` -> `/Users/a/b.css`. The page is served at the same
 * absolute paths, so links written for opening the file on the machine itself
 * keep working.
 */
export function rewriteFileUrls(text: string): string {
  return text.replace(/file:\/\/(?:localhost)?(?=\/)/gi, "");
}

/** The URL path a file is served at: its absolute path, each segment encoded. */
export function previewUrlPath(absPath: string): string {
  return absPath.split("/").map(encodeURIComponent).join("/");
}

function dirName(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

/**
 * What the page may read: the git checkout around the file, else the file's
 * own folder. Never `/`.
 */
export async function previewRoot(
  path: string,
  list: (dir: string) => Promise<DirEntry[]>,
  maxDepth = 16,
): Promise<string> {
  const start = dirName(path);
  let dir = start;
  for (let depth = 0; depth < maxDepth && dir !== "/"; depth++) {
    let entries: DirEntry[];
    try {
      entries = await list(dir);
    } catch {
      break;
    }
    if (entries.some((entry) => entry.name === ".git")) return dir;
    dir = dirName(dir);
  }
  return start;
}

export type ResolvedRequest = { path: string } | { status: number; message: string };

/**
 * Maps a request path from the page onto a file under `root`. Hidden files
 * and folders (`.env`, `.git/`) are never served.
 */
export function resolvePreviewRequest(root: string, requestPath: string): ResolvedRequest {
  if (!requestPath.startsWith("/")) return { status: 400, message: "Bad path" };
  const segments = requestPath.split("/").filter(Boolean);
  if (segments.some((s) => s === "." || s === "..")) return { status: 400, message: "Bad path" };
  if (segments.some((s) => s.startsWith("."))) return { status: 403, message: "Hidden files are not served" };
  let path = "/" + segments.join("/");
  if (requestPath.endsWith("/")) path = path === "/" ? "/index.html" : `${path}/index.html`;
  const base = root === "/" ? "/" : `${root}/`;
  if (!path.startsWith(base)) return { status: 403, message: "Outside the previewed project" };
  return { path };
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function fileResponse(file: RemoteFile): PreviewResponse {
  const mime = previewMime(file.name, file.mime);
  if (!REWRITTEN.has(mime)) return { status: 200, mime, dataBase64: file.data_base64 };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(base64ToBytes(file.data_base64));
  } catch {
    // Another encoding: served untouched, with the charset left to the page.
    return { status: 200, mime, dataBase64: file.data_base64 };
  }
  const rewritten = rewriteFileUrls(text);
  return {
    status: 200,
    mime: `${mime}; charset=utf-8`,
    dataBase64:
      rewritten === text ? file.data_base64 : bytesToBase64(new TextEncoder().encode(rewritten)),
  };
}

export function errorResponse(status: number, message: string): PreviewResponse {
  return {
    status,
    mime: "text/plain; charset=utf-8",
    dataBase64: bytesToBase64(new TextEncoder().encode(message)),
  };
}

export function readErrorResponse(err: unknown): PreviewResponse {
  if (err instanceof RemoteFileError) {
    switch (err.code) {
      case "not_found":
        return errorResponse(404, "Not found");
      case "permission_denied":
        return errorResponse(403, "Permission denied");
      case "too_large":
        return errorResponse(413, "Too large");
      case "timeout":
        return errorResponse(504, "The machine did not answer");
      default:
        return errorResponse(502, err.message);
    }
  }
  return errorResponse(502, err instanceof Error ? err.message : String(err));
}

/** Answers one request of the page: `requestPath` is already URL-decoded. */
export async function answerPreviewRequest(
  root: string,
  requestPath: string,
  read: (path: string) => Promise<RemoteFile>,
): Promise<PreviewResponse> {
  const resolved = resolvePreviewRequest(root, requestPath);
  if ("status" in resolved) return errorResponse(resolved.status, resolved.message);
  try {
    return fileResponse(await read(resolved.path));
  } catch (err) {
    return readErrorResponse(err);
  }
}
