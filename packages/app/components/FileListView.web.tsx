import type { DirEntry } from "@offdesk/shared";
import { colors } from "@/lib/colors";
import { formatEntrySize, formatRelativeTime, isTooLarge } from "@/lib/fileBrowser";
import type { SortKey, SortSpec } from "@/lib/fileManager";
import { rem } from "@/lib/rem";
import "./FileBrowser.css";
import { clickModifiers, rowInteractionProps, type ClickModifiers, type RowInteraction } from "./FileRowEvents";
import { FileRenameInput } from "./FileRenameInput.web";
import { iconForEntry, kindLabel } from "./FileBrowserShared.web";

// Name | Size | Modified | Kind
const COLUMNS = "minmax(0, 1fr) 92px 112px 84px";

const HEADERS: { key: SortKey; label: string; align: "left" | "right" }[] = [
  { key: "name", label: "Name", align: "left" },
  { key: "size", label: "Size", align: "right" },
  { key: "modified", label: "Modified", align: "right" },
  { key: "kind", label: "Kind", align: "left" },
];

export interface FileViewProps {
  entries: DirEntry[];
  selected: ReadonlySet<string>;
  touch: boolean;
  onSelect: (entry: DirEntry, mods: ClickModifiers) => void;
  onOpen: (entry: DirEntry) => void;
  /** Desktop: inline rename and drag & drop. */
  interaction?: RowInteraction;
  /** Phone: selection mode (rows toggle instead of opening, with a check mark). */
  selecting?: boolean;
  /** Phone: the row being renamed in place. */
  rename?: { path: string | null; onCommit: RowInteraction["onRenameCommit"]; onCancel: () => void };
}

/**
 * The directory as rows. Desktop: sortable column headers, click selects and
 * double-click opens. Phone: the original single-tap rows.
 */
export function FileListView({
  entries,
  selected,
  touch,
  sort,
  onSort,
  onSelect,
  onOpen,
  interaction,
  selecting,
  rename,
}: FileViewProps & { sort: SortSpec; onSort: (key: SortKey) => void }) {
  return (
    <>
      {!touch && (
        <div
          role="row"
          data-testid="file-browser-header"
          style={{
            position: "sticky",
            top: 0,
            zIndex: 1,
            display: "grid",
            gridTemplateColumns: COLUMNS,
            gap: 12,
            padding: "0 20px 0 46px",
            background: colors.bg1,
            borderBottom: `1px solid ${colors.lineSoft}`,
          }}
        >
          {HEADERS.map((h) => {
            const active = sort.key === h.key;
            return (
              <button
                key={h.key}
                type="button"
                className="odk-fb-sort"
                data-testid="file-browser-sort"
                data-key={h.key}
                aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
                onClick={() => onSort(h.key)}
                style={{
                  height: 28,
                  padding: 0,
                  border: "none",
                  background: "transparent",
                  cursor: "pointer",
                  textAlign: h.align,
                  fontFamily: "var(--font-display)",
                  fontSize: rem(11.5),
                  textTransform: "lowercase",
                  color: active ? colors.fg0 : colors.fg3,
                }}
              >
                {h.label}
                {active ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}
              </button>
            );
          })}
        </div>
      )}
      {entries.map((entry) => (
        <FileListRow
          key={entry.path}
          entry={entry}
          isSelected={selected.has(entry.path)}
          touch={touch}
          selecting={selecting}
          rename={rename}
          onSelect={onSelect}
          onOpen={onOpen}
          interaction={interaction}
        />
      ))}
    </>
  );
}

function FileListRow({
  entry,
  isSelected,
  touch,
  onSelect,
  onOpen,
  interaction,
  selecting,
  rename,
}: {
  entry: DirEntry;
  isSelected: boolean;
  touch: boolean;
  selecting?: boolean;
  rename?: FileViewProps["rename"];
  onSelect: FileViewProps["onSelect"];
  onOpen: FileViewProps["onOpen"];
  interaction?: RowInteraction;
}) {
  const renaming = (touch ? rename?.path : interaction?.renamingPath) === entry.path;
  // An input cannot live inside a button, so a renaming row is a plain div.
  const Root = (renaming ? "div" : "button") as "button";
  const tooLarge = isTooLarge(entry);
  const size = formatEntrySize(entry);
  const Icon = iconForEntry(entry);
  const subtle = isSelected ? colors.onPrimary : colors.fg3;
  return (
    <Root
      type="button"
      data-row=""
      data-testid="file-browser-row"
      data-name={entry.name}
      data-path={entry.path}
      {...(touch ? {} : rowInteractionProps(entry, interaction))}
      data-kind={entry.is_dir ? "dir" : "file"}
      data-selected={isSelected ? "true" : "false"}
      className="odk-fb-row"
      // An over-limit file cannot be opened but stays selectable (for later
      // actions, and so a long-press can start on it).
      aria-disabled={tooLarge && !selecting ? true : undefined}
      aria-selected={touch && selecting ? isSelected : undefined}
      title={tooLarge ? "Over 20 MB" : entry.path}
      onClick={(event) => {
        if (!touch) return onSelect(entry, clickModifiers(event));
        if (renaming) return;
        // In selection mode a tap toggles; otherwise it opens (onOpen skips over-limit files).
        if (selecting) onSelect(entry, { toggle: true, range: false });
        else onOpen(entry);
      }}
      onDoubleClick={touch ? undefined : () => onOpen(entry)}
      style={{
        width: "100%",
        display: touch ? "flex" : "grid",
        gridTemplateColumns: touch ? undefined : COLUMNS,
        alignItems: "center",
        gap: 12,
        minHeight: touch ? 52 : 32,
        padding: touch ? "0 16px" : "0 20px 0 20px",
        border: "none",
        borderRadius: touch ? 0 : 3,
        borderBottom: touch ? `1px solid ${colors.lineSoft}` : "none",
        background: isSelected ? colors.primary : undefined,
        color: isSelected ? colors.onPrimary : tooLarge ? colors.fg3 : colors.fg0,
        fontWeight: isSelected ? 600 : 400,
        cursor: tooLarge && !selecting ? "not-allowed" : "pointer",
        textAlign: "left",
        fontFamily: "var(--font-display)",
        fontSize: rem(touch ? 14 : 13.5),
        userSelect: "none",
        WebkitUserSelect: "none",
        WebkitTouchCallout: "none",
        scrollMarginTop: 30,
      }}
    >
      {touch ? (
        <>
          {selecting && (
            <span
              aria-hidden
              data-testid="file-browser-row-check"
              style={{
                width: 22,
                height: 22,
                flexShrink: 0,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 11,
                border: `2px solid ${isSelected ? colors.onPrimary : colors.fg3}`,
                background: isSelected ? colors.onPrimary : "transparent",
                color: colors.primary,
                fontSize: rem(13),
                fontWeight: 700,
              }}
            >
              {isSelected ? "✓" : ""}
            </span>
          )}
          <span aria-hidden style={{ width: 32, flexShrink: 0, fontSize: rem(11), fontWeight: 400, color: isSelected ? colors.onPrimary : colors.fg3 }}>
            {entryType(entry)}
          </span>
          {renaming && rename ? (
            <FileRenameInput entry={entry} touch onCommit={rename.onCommit} onCancel={rename.onCancel} />
          ) : (
            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {entry.is_dir ? `${entry.name}/` : entry.name}
            </span>
          )}
          {tooLarge && (
            <span style={{ fontSize: rem(12), fontWeight: 400, color: subtle, flexShrink: 0 }}>
              {size} · over 20 MB
            </span>
          )}
          {!tooLarge && size && (
            <span data-testid="file-browser-size" style={{ fontSize: rem(12), fontWeight: 400, color: subtle, flexShrink: 0 }}>
              {size}
            </span>
          )}
          {entry.is_dir && (
            <span aria-hidden style={{ color: subtle, flexShrink: 0 }}>›</span>
          )}
          <span style={{ width: 84, textAlign: "right", fontSize: rem(11), fontWeight: 400, color: subtle, flexShrink: 0 }}>
            {formatRelativeTime(entry.modified_ms)}
          </span>
        </>
      ) : (
        <>
          <span style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
            <Icon size={16} aria-hidden style={{ flexShrink: 0, color: isSelected ? colors.onPrimary : entry.is_dir ? colors.primary : colors.fg3 }} />
            {renaming && interaction ? (
              <FileRenameInput
                entry={entry}
                onCommit={interaction.onRenameCommit}
                onCancel={interaction.onRenameCancel}
              />
            ) : (
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {entry.is_dir ? `${entry.name}/` : entry.name}
              </span>
            )}
            {tooLarge && !renaming && (
              <span style={{ fontSize: rem(11.5), fontWeight: 400, color: subtle, flexShrink: 0 }}>
                over 20 MB
              </span>
            )}
          </span>
          <span
            data-testid={size ? "file-browser-size" : undefined}
            style={{ textAlign: "right", fontSize: rem(12), fontWeight: 400, color: subtle }}
          >
            {size}
          </span>
          <span style={{ textAlign: "right", fontSize: rem(12), fontWeight: 400, color: subtle }}>
            {formatRelativeTime(entry.modified_ms)}
          </span>
          <span style={{ fontSize: rem(12), fontWeight: 400, color: subtle, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {kindLabel(entry)}
          </span>
        </>
      )}
    </Root>
  );
}

// The 32px type column on the phone: `dir`, or the extension, else `file`.
function entryType(entry: { name: string; is_dir: boolean }): string {
  if (entry.is_dir) return "dir";
  const dot = entry.name.lastIndexOf(".");
  const ext = dot > 0 ? entry.name.slice(dot + 1).toLowerCase() : "";
  return ext && ext.length <= 4 ? ext : "file";
}
