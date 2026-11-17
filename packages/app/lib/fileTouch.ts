// Pure logic behind the phone's file manager: the long-press thresholds, the
// action bar contents, the "paste here" bar and the click that follows a
// long-press.
import type { DirEntry } from "@offdesk/shared";
import { pasteDecision } from "./fileManager";
import type { FileClipboard } from "./fileManager";

/** Hold time before a row press enters selection mode. */
export const FILE_LONG_PRESS_MS = 450;
/** Movement that turns the press into a scroll or drag instead. */
export const FILE_LONG_PRESS_SLOP_PX = 10;

export const selectionTitle = (count: number): string => `${count} selected`;

const itemsLabel = (count: number): string => `${count} ${count === 1 ? "item" : "items"}`;

// ---------------------------------------------------------------- action bar

export type MobileActionId =
  | "download"
  | "move"
  | "copy"
  | "rename"
  | "trash"
  | "more"
  | "duplicate"
  | "copy-path"
  | "open-terminal"
  | "pin";

export interface MobileAction {
  id: MobileActionId;
  label: string;
  danger?: boolean;
}

export interface MobileActionContext {
  targets: DirEntry[];
  canEdit: boolean;
  canOpenTerminal: boolean;
  /** Folders already pinned to Places. */
  pinned: string[];
}

/** The bottom action bar in selection mode; mutating actions need `canEdit`. */
export function mobileBarActions(ctx: Pick<MobileActionContext, "targets" | "canEdit">): MobileAction[] {
  const { targets, canEdit } = ctx;
  if (targets.length === 0) return [];
  const zip = targets.length > 1 || targets.some((e) => e.is_dir);
  const out: MobileAction[] = [{ id: "download", label: zip ? "Zip" : "Download" }];
  if (canEdit) {
    out.push({ id: "move", label: "Move" }, { id: "copy", label: "Copy" });
    if (targets.length === 1) out.push({ id: "rename", label: "Rename" });
    out.push({ id: "trash", label: "Trash", danger: true });
  }
  out.push({ id: "more", label: "More" });
  return out;
}

/** The "More" sheet: Duplicate, Copy Path, Open in Terminal, Pin to Places. */
export function mobileMoreActions(ctx: MobileActionContext): MobileAction[] {
  const { targets, canEdit } = ctx;
  if (targets.length === 0) return [];
  const single = targets.length === 1 ? targets[0] : null;
  const out: MobileAction[] = [];
  if (canEdit) out.push({ id: "duplicate", label: "Duplicate" });
  out.push({ id: "copy-path", label: targets.length > 1 ? "Copy Paths" : "Copy Path" });
  if (ctx.canOpenTerminal && single) out.push({ id: "open-terminal", label: "Open in Terminal" });
  if (single?.is_dir) {
    out.push({
      id: "pin",
      label: ctx.pinned.includes(single.path) ? "Remove from Places" : "Pin to Places",
    });
  }
  return out;
}

// ---------------------------------------------------------------- paste bar

export interface PasteBarState {
  /** The bar shows while this machine's clipboard holds items (and files are editable). */
  visible: boolean;
  label: string;
  /** Whether Paste can run in the folder being shown. */
  ok: boolean;
  /** Why it cannot, when it cannot. */
  reason: string | null;
  verb: "Move" | "Copy";
}

export function pasteBarState(
  clip: FileClipboard | null,
  machineId: string,
  destDir: string,
  canEdit: boolean,
): PasteBarState {
  if (!canEdit || !clip || clip.paths.length === 0 || clip.machineId !== machineId) {
    return { visible: false, label: "", ok: false, reason: null, verb: "Copy" };
  }
  const decision = pasteDecision(clip, machineId, destDir);
  return {
    visible: true,
    label: `Paste ${itemsLabel(clip.paths.length)} here`,
    ok: decision.ok,
    reason: decision.ok ? null : decision.reason,
    verb: clip.mode === "cut" ? "Move" : "Copy",
  };
}

// ---------------------------------------------------------------- long-press click

/**
 * A long-press that ends with the finger lifting still produces a click on the
 * row; that click must not toggle the selection the long-press just made.
 */
export function createClickSuppressor(now: () => number = () => Date.now(), windowMs = 700) {
  let armedAt: number | null = null;
  return {
    arm() {
      armedAt = now();
    },
    /** True once per arm, while the window lasts. */
    consume(): boolean {
      if (armedAt === null) return false;
      const fresh = now() - armedAt <= windowMs;
      armedAt = null;
      return fresh;
    },
    clear() {
      armedAt = null;
    },
  };
}
