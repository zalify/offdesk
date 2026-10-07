import type { DirEntry } from "@offdesk/shared";
import { MAX_FETCH_BYTES } from "./fetchRemoteFile";
import { formatBytes } from "./resourceStats";

export interface Crumb {
  label: string;
  path: string;
}

/** Directories first, then files; each group alphabetical, case-insensitive. */
export function sortEntries(entries: DirEntry[]): DirEntry[] {
  return [...entries].sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    const la = a.name.toLowerCase();
    const lb = b.name.toLowerCase();
    if (la < lb) return -1;
    if (la > lb) return 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

export function filterEntries(entries: DirEntry[], query: string): DirEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return entries;
  return entries.filter((entry) => entry.name.toLowerCase().includes(needle));
}

function trimTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") || "/" : path;
}

/**
 * Splits a path into clickable segments. Paths under `home` (or starting with
 * `~`) start from a "~" crumb; others start from "/".
 */
export function splitBreadcrumb(rawPath: string, home?: string): Crumb[] {
  const path = trimTrailingSlash(rawPath || "~");
  const homeDir = home ? trimTrailingSlash(home) : undefined;
  let rootPath: string;
  let rootLabel: string;
  let rest: string[];
  if (path === "~" || path.startsWith("~/")) {
    rootPath = "~";
    rootLabel = "~";
    rest = path.slice(2).split("/").filter(Boolean);
  } else if (homeDir && homeDir !== "/" && (path === homeDir || path.startsWith(`${homeDir}/`))) {
    rootPath = homeDir;
    rootLabel = "~";
    rest = path.slice(homeDir.length).split("/").filter(Boolean);
  } else {
    rootPath = "/";
    rootLabel = "/";
    rest = path.split("/").filter(Boolean);
  }
  const crumbs: Crumb[] = [{ label: rootLabel, path: rootPath }];
  let current = rootPath;
  for (const segment of rest) {
    current = current === "/" ? `/${segment}` : `${current}/${segment}`;
    crumbs.push({ label: segment, path: current });
  }
  return crumbs;
}

/** The parent directory, or null at a root ("/" or "~"/home stays put). */
export function parentPath(path: string, home?: string): string | null {
  const crumbs = splitBreadcrumb(path, home);
  if (crumbs.length > 1) return crumbs[crumbs.length - 2].path;
  // "~" is the root crumb of its own chain; climb out of home to its parent.
  if (crumbs[0].label === "~" && home) {
    const homeDir = trimTrailingSlash(home);
    const idx = homeDir.lastIndexOf("/");
    if (homeDir !== "/" && idx >= 0) return idx === 0 ? "/" : homeDir.slice(0, idx);
  }
  return null;
}

export function formatRelativeTime(ms: number | undefined, now = Date.now()): string {
  if (ms === undefined || !Number.isFinite(ms)) return "";
  const diff = Math.max(0, now - ms);
  const sec = Math.floor(diff / 1000);
  if (sec < 45) return "刚刚";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${Math.max(1, min)} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天前`;
  const month = Math.floor(day / 30);
  if (month < 12) return `${month} 个月前`;
  return `${Math.floor(day / 365)} 年前`;
}

export function formatEntrySize(entry: DirEntry): string {
  if (entry.is_dir || entry.size === undefined) return "";
  return formatBytes(entry.size);
}

export function isTooLarge(entry: DirEntry): boolean {
  return !entry.is_dir && (entry.size ?? 0) > MAX_FETCH_BYTES;
}

export type ListErrorKind = "permission_denied" | "not_found" | "offline" | "other";

export function classifyListError(err: unknown): ListErrorKind {
  const status =
    err && typeof err === "object" && "status" in err
      ? Number((err as { status: unknown }).status)
      : undefined;
  const text = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (text.includes("permission denied")) return "permission_denied";
  if (text.includes("no such file") || text.includes("not a directory") || text.includes("cannot find")) {
    return "not_found";
  }
  if (
    status === 502 ||
    status === 503 ||
    status === 504 ||
    text.includes("not connected") ||
    text.includes("disconnected") ||
    text.includes("offline") ||
    text.includes("timed out") ||
    text.includes("timeout") ||
    text.includes("failed to fetch")
  ) {
    return "offline";
  }
  if (status === 404 || text.includes("not found")) return "not_found";
  return "other";
}

export function describeListError(err: unknown, path: string): string {
  switch (classifyListError(err)) {
    case "permission_denied":
      return `没有权限打开 ${path}`;
    case "not_found":
      return `找不到目录 ${path}`;
    case "offline":
      return "机器不在线或没有响应";
    default: {
      const message = err instanceof Error ? err.message : String(err);
      return `无法打开 ${path}：${message}`;
    }
  }
}

// Last directory per machine, for this session only.
const lastDirs = new Map<string, string>();

export function rememberDirectory(machineId: string, path: string): void {
  lastDirs.set(machineId, path);
}

export function rememberedDirectory(machineId: string): string | undefined {
  return lastDirs.get(machineId);
}

export function resolveStartPath(opts: {
  machineId: string;
  givenPath?: string | null;
  cwd?: string | null;
}): string {
  return (
    opts.givenPath || opts.cwd || rememberedDirectory(opts.machineId) || "~"
  );
}
