import { useEffect, useRef } from "react";
import { colors } from "@/lib/colors";
import { gridColumns, isThumbnailable } from "@/lib/fileGrid";
import { isTooLarge } from "@/lib/fileBrowser";
import { rem } from "@/lib/rem";
import "./FileBrowser.css";
import { clickModifiers, rowInteractionProps } from "./FileRowEvents";
import { FileRenameInput } from "./FileRenameInput.web";
import { FileThumbnail } from "./FileThumbnail.web";
import { iconForEntry } from "./FileBrowserShared.web";
import type { FileViewProps } from "./FileListView.web";

const TILE = 116;
const GAP = 8;

/** The directory as a grid of tiles; image files show lazy thumbnails. */
export function FileIconView({
  machineId,
  entries,
  selected,
  onSelect,
  onOpen,
  interaction,
  onColumnsChange,
}: Omit<FileViewProps, "touch"> & {
  machineId: string;
  /** Reports how many tiles fit per row, for ↑/↓ keyboard movement. */
  onColumnsChange: (columns: number) => void;
}) {
  const gridRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const measure = () => onColumnsChange(gridColumns(el.clientWidth - 24, TILE, GAP));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [onColumnsChange]);

  return (
    <div
      ref={gridRef}
      data-testid="file-browser-grid"
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(auto-fill, ${TILE}px)`,
        gap: GAP,
        padding: 12,
        alignContent: "start",
      }}
    >
      {entries.map((entry) => {
        const isSelected = selected.has(entry.path);
        const tooLarge = isTooLarge(entry);
        const Icon = iconForEntry(entry);
        const icon = (
          <Icon
            size={40}
            strokeWidth={1.25}
            aria-hidden
            style={{ color: entry.is_dir ? colors.primary : colors.fg3 }}
          />
        );
        const renaming = interaction?.renamingPath === entry.path;
        // An input cannot live inside a button, so a renaming tile is a plain div.
        const Tile = (renaming ? "div" : "button") as "button";
        return (
          <Tile
            key={entry.path}
            type="button"
            data-row=""
            data-testid="file-browser-row"
            data-name={entry.name}
            data-path={entry.path}
            {...rowInteractionProps(entry, interaction)}
            data-kind={entry.is_dir ? "dir" : "file"}
            data-selected={isSelected ? "true" : "false"}
            className="odk-fb-tile"
            aria-disabled={tooLarge ? true : undefined}
            title={tooLarge ? "Over 20 MB" : entry.path}
            onClick={(event) => onSelect(entry, clickModifiers(event))}
            onDoubleClick={() => onOpen(entry)}
            style={{
              width: TILE,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 6,
              padding: "8px 6px",
              border: "none",
              borderRadius: 4,
              background: isSelected ? colors.bg3 : undefined,
              outline: isSelected ? `1px solid ${colors.primary}` : "none",
              color: tooLarge ? colors.fg3 : colors.fg0,
              cursor: tooLarge ? "not-allowed" : "pointer",
              fontFamily: "var(--font-display)",
              fontSize: rem(12),
              userSelect: "none",
            }}
          >
            <span style={{ width: 84, height: 64, display: "flex", alignItems: "center", justifyContent: "center" }}>
              {isThumbnailable(entry) ? (
                <FileThumbnail machineId={machineId} entry={entry} fallback={icon} />
              ) : (
                icon
              )}
            </span>
            {renaming && interaction ? (
              <FileRenameInput
                entry={entry}
                centered
                onCommit={interaction.onRenameCommit}
                onCancel={interaction.onRenameCancel}
              />
            ) : (
            <span
              style={{
                width: "100%",
                textAlign: "center",
                wordBreak: "break-word",
                lineHeight: 1.25,
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}
            >
              {entry.name}
            </span>
            )}
          </Tile>
        );
      })}
    </div>
  );
}
