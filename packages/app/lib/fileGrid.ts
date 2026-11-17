// Pure helpers for the file browser's icon grid: arrow-key movement and
// thumbnail eligibility.
import type { DirEntry } from "@offdesk/shared";

export type ArrowKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight";

/**
 * How far an arrow key moves the focused index. In a list (`columns` = 1) only
 * up/down apply; in a grid left/right step by one and up/down by a row. A move
 * past the first row stays put; down from a row above a partial last row lands
 * on the last item.
 */
export function gridMoveDelta(
  index: number,
  key: ArrowKey,
  columns: number,
  count: number,
): number {
  if (count <= 0) return 0;
  const cols = Math.max(1, Math.floor(columns));
  const last = count - 1;
  switch (key) {
    case "ArrowLeft":
      return cols === 1 ? 0 : index > 0 ? -1 : 0;
    case "ArrowRight":
      return cols === 1 ? 0 : index < last ? 1 : 0;
    case "ArrowUp":
      return index - cols >= 0 ? -cols : 0;
    case "ArrowDown":
      if (index + cols <= last) return cols;
      // A partial last row below: go to its final item.
      return Math.floor(index / cols) < Math.floor(last / cols) ? last - index : 0;
  }
}

/** Number of tile columns that fit `width` px given a tile and gap size. */
export function gridColumns(width: number, tile: number, gap: number): number {
  return Math.max(1, Math.floor((width + gap) / (tile + gap)));
}

export const THUMB_MAX_BYTES = 5 * 1024 * 1024;
const THUMB_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);

/** Image files small enough to preview as a tile thumbnail. */
export function isThumbnailable(entry: DirEntry): boolean {
  if (entry.is_dir) return false;
  if ((entry.size ?? 0) > THUMB_MAX_BYTES) return false;
  const idx = entry.name.lastIndexOf(".");
  return idx > 0 && THUMB_EXT.has(entry.name.slice(idx + 1).toLowerCase());
}
