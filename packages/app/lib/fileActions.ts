// Pure logic behind the file manager's actions: default names, drop-target
// validity, the context-menu item list, the session clipboard.
import type { DirEntry } from "@offdesk/shared";
import { isTooLarge } from "./fileBrowser";
import { basename, dirname, pasteDecision, validateName } from "./fileManager";
import type { FileClipboard, Selection } from "./fileManager";

// ---------------------------------------------------------------- names

/** Splits "a.tar.gz" into ["a.tar", ".gz"]; dotfiles and folders have no extension. */
export function splitExtension(name: string, isDir: boolean): [string, string] {
  if (isDir) return [name, ""];
  const idx = name.lastIndexOf(".");
  if (idx <= 0 || idx === name.length - 1) return [name, ""];
  return [name.slice(0, idx), name.slice(idx)];
}

/** Length of the part of `name` an inline rename selects: the stem for files. */
export function renameSelectionEnd(name: string, isDir: boolean): number {
  return splitExtension(name, isDir)[0].length;
}

/**
 * A free default name for a new item: "untitled folder", "untitled folder 2",
 * ... or "untitled.txt", "untitled 2.txt", ... Case-insensitive against
 * `existing`, as the common filesystems are.
 */
export function freeDefaultName(kind: "folder" | "file", existing: Iterable<string>): string {
  const taken = new Set([...existing].map((n) => n.toLowerCase()));
  const [stem, ext] = kind === "folder" ? ["untitled folder", ""] : ["untitled", ".txt"];
  let candidate = `${stem}${ext}`;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${stem} ${n}${ext}`;
  return candidate;
}

/** Normalises a typed name; returns an error message, or null when it is fine to submit. */
export function checkRenameInput(name: string): string | null {
  return validateName(name);
}

// ---------------------------------------------------------------- editor guard

/** True when any of `paths` is, or contains, the file open with unsaved changes. */
export function touchesDirtyFile(paths: string[], dirtyPath: string | null): boolean {
  if (dirtyPath === null) return false;
  return paths.some((p) => {
    const root = p.length > 1 ? p.replace(/\/+$/, "") : p;
    return dirtyPath === root || dirtyPath.startsWith(`${root}/`);
  });
}

export const DIRTY_FILE_NOTICE = "Save or close the open file's changes first";

// ---------------------------------------------------------------- drag & drop

export const INTERNAL_DRAG_MIME = "application/x-webmux-files";

/** What an in-app drag carries; the payload is also kept in memory (dragover cannot read it). */
export interface InternalDrag {
  machineId: string;
  paths: string[];
}

export type DropDecision = { ok: true; op: "move" | "copy" } | { ok: false; reason: string };

/** Whether dragging `paths` onto folder `destDir` is allowed, and as which op. */
export function dropDecision(
  drag: InternalDrag,
  machineId: string,
  destDir: string,
  copy: boolean,
): DropDecision {
  const clip: FileClipboard = {
    mode: copy ? "copy" : "cut",
    machineId: drag.machineId,
    paths: drag.paths,
  };
  return pasteDecision(clip, machineId, destDir);
}

/** Folder a drop on `entry` lands in; a file row drops into the listing's folder. */
export function dropDestination(entry: DirEntry | null, currentDir: string): string {
  return entry?.is_dir ? entry.path : currentDir;
}

// ---------------------------------------------------------------- clipboard

let clipboard: FileClipboard | null = null;
const clipboardListeners = new Set<() => void>();

/** Session-wide file clipboard; survives closing and reopening the overlay. */
export const getFileClipboard = (): FileClipboard | null => clipboard;

export function setFileClipboard(next: FileClipboard | null): void {
  clipboard = next;
  for (const listener of clipboardListeners) listener();
}

export function subscribeFileClipboard(listener: () => void): () => void {
  clipboardListeners.add(listener);
  return () => clipboardListeners.delete(listener);
}

// ---------------------------------------------------------------- selection

/** A selection of exactly `paths` (the last one focused). */
export function selectionOf(paths: string[]): Selection {
  const last = paths.length > 0 ? paths[paths.length - 1] : null;
  return { selected: new Set(paths), anchor: last, focus: last };
}

/** Entries a menu / key action applies to: the selection, or just the clicked item. */
export function actionTargets(
  clicked: DirEntry | null,
  selected: DirEntry[],
): DirEntry[] {
  if (!clicked) return selected;
  return selected.some((e) => e.path === clicked.path) ? selected : [clicked];
}

// ---------------------------------------------------------------- context menu

export type MenuActionId =
  | "open"
  | "quicklook"
  | "rename"
  | "duplicate"
  | "copy"
  | "cut"
  | "paste"
  | "trash"
  | "download"
  | "copy-path"
  | "open-terminal"
  | "pin"
  | "new-folder"
  | "new-file"
  | "upload"
  | "refresh"
  | "show-hidden";

export type MenuSpec =
  | "separator"
  | { id: MenuActionId; label: string; shortcut?: string; disabled?: boolean };

export interface MenuContext {
  /** The items the menu applies to; empty for the empty-area menu. */
  targets: DirEntry[];
  canEdit: boolean;
  machineId: string;
  /** Folder being listed. */
  currentDir: string;
  clipboard: FileClipboard | null;
  canOpenTerminal: boolean;
  showHidden: boolean;
  pinned: string[];
  /** The platform's modifier glyph for shortcuts. */
  mod?: string;
}

/** Folder a paste from this menu lands in. */
export function pasteTarget(targets: DirEntry[], currentDir: string): string {
  return targets.length === 1 && targets[0].is_dir ? targets[0].path : currentDir;
}

export function buildMenu(ctx: MenuContext): MenuSpec[] {
  const { targets, canEdit } = ctx;
  const mod = ctx.mod ?? "⌘";
  const out: MenuSpec[] = [];
  const sep = () => {
    if (out.length > 0 && out[out.length - 1] !== "separator") out.push("separator");
  };

  const pasteItem = (): MenuSpec | null => {
    if (!canEdit || !ctx.clipboard) return null;
    const dest = pasteTarget(targets, ctx.currentDir);
    const ok = pasteDecision(ctx.clipboard, ctx.machineId, dest).ok;
    const label =
      targets.length === 1 && targets[0].is_dir ? `Paste into “${targets[0].name}”` : "Paste";
    return { id: "paste", label, shortcut: `${mod}V`, disabled: !ok };
  };

  if (targets.length === 0) {
    if (canEdit) {
      out.push({ id: "new-folder", label: "New Folder", shortcut: `${mod}⇧N` });
      out.push({ id: "new-file", label: "New File" });
      const paste = pasteItem();
      if (paste) out.push(paste);
      out.push({ id: "upload", label: "Upload…" });
      sep();
    }
    if (ctx.canOpenTerminal) out.push({ id: "open-terminal", label: "Open in Terminal" });
    out.push({ id: "refresh", label: "Refresh" });
    out.push({
      id: "show-hidden",
      label: ctx.showHidden ? "Hide Hidden Files" : "Show Hidden Files",
    });
    return out;
  }

  const single = targets.length === 1 ? targets[0] : null;
  if (single) {
    out.push({ id: "open", label: "Open" });
    if (!single.is_dir) {
      out.push({
        id: "quicklook",
        label: "Quick Look",
        shortcut: "Space",
        disabled: isTooLarge(single),
      });
    }
    sep();
  }
  if (canEdit) {
    if (single) out.push({ id: "rename", label: "Rename", shortcut: "F2" });
    out.push({ id: "duplicate", label: "Duplicate", shortcut: `${mod}D` });
    out.push({ id: "copy", label: "Copy", shortcut: `${mod}C` });
    out.push({ id: "cut", label: "Cut", shortcut: `${mod}X` });
    const paste = pasteItem();
    if (paste) out.push(paste);
    sep();
    out.push({ id: "trash", label: "Move to Trash", shortcut: `${mod}⌫` });
    sep();
  }
  const zip = targets.length > 1 || targets.some((e) => e.is_dir);
  out.push({ id: "download", label: zip ? "Download as Zip" : "Download" });
  out.push({ id: "copy-path", label: targets.length > 1 ? "Copy Paths" : "Copy Path" });
  if (ctx.canOpenTerminal && single) out.push({ id: "open-terminal", label: "Open in Terminal" });
  if (single?.is_dir) {
    out.push({
      id: "pin",
      label: ctx.pinned.includes(single.path) ? "Remove from Sidebar" : "Pin to Sidebar",
    });
  }
  return out;
}

/** Folder "Open in Terminal" starts in for these targets. */
export function terminalDirFor(targets: DirEntry[], currentDir: string): string {
  if (targets.length !== 1) return currentDir;
  const t = targets[0];
  return t.is_dir ? t.path : dirname(t.path) || currentDir;
}

// ---------------------------------------------------------------- messages

export function trashedNotice(entries: DirEntry[]): string {
  const n = entries.length;
  return `Moved ${n} ${n === 1 ? "item" : "items"} to Trash`;
}

/** Display name of the item a conflict error names. */
export function conflictName(path: string | undefined, fallback: string): string {
  return path ? basename(path) : fallback;
}
