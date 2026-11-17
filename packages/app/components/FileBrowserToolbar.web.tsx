import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { ChevronLeft, ChevronRight, FolderPlus, LayoutGrid, List, Pin, Upload } from "lucide-react";
import { colors } from "@/lib/colors";
import type { Crumb } from "@/lib/fileBrowser";
import { rem } from "@/lib/rem";
import { SPIN, toolButtonStyle } from "./FileBrowserShared.web";

export interface ToolbarProps {
  touch: boolean;
  crumbs: Crumb[];
  up: string | null;
  loading: boolean;
  canBack: boolean;
  canForward: boolean;
  onBack: () => void;
  onForward: () => void;
  onGo: (path: string) => void;
  onRefresh: () => void;
  /** Desktop: the breadcrumb is an editable path field while true. */
  editingPath: boolean;
  onEditingPathChange: (editing: boolean) => void;
  currentPath: string;
  pinned: boolean;
  onTogglePin: () => void;
  view: "list" | "icons";
  onViewChange: (view: "list" | "icons") => void;
  filter: string;
  onFilterChange: (value: string) => void;
  filterRef: RefObject<HTMLInputElement | null>;
  showHidden: boolean;
  onShowHiddenChange: (value: boolean) => void;
  /** Desktop: "new folder" and "upload" show while the files are editable. */
  canEdit?: boolean;
  onNewFolder?: () => void;
  onUpload?: () => void;
}

/** Filter box and show-hidden toggle; in the toolbar on desktop, a row of their own on the phone. */
export function FileFilterControls({
  touch,
  filter,
  onFilterChange,
  filterRef,
  showHidden,
  onShowHiddenChange,
}: Pick<ToolbarProps, "touch" | "filter" | "onFilterChange" | "filterRef" | "showHidden" | "onShowHiddenChange">) {
  return (
    <>
      <input
        ref={filterRef}
        data-testid="file-browser-filter"
        aria-label="Filter by name"
        value={filter}
        onChange={(event) => onFilterChange(event.target.value)}
        placeholder="filter by name"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        style={{
          flex: touch ? 1 : "0 0 180px",
          minWidth: 0,
          minHeight: touch ? 40 : 32,
          padding: "0 12px",
          fontFamily: "var(--font-display)",
          fontSize: rem(touch ? 16 : 13),
          color: colors.fg0,
          background: colors.bg0,
          border: `1px solid ${colors.line}`,
          borderRadius: 4,
          outline: "none",
        }}
      />
      <label
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          fontSize: rem(12.5),
          color: colors.fg2,
          cursor: "pointer",
          flexShrink: 0,
          minHeight: touch ? 38 : undefined,
        }}
      >
        <input
          type="checkbox"
          data-testid="file-browser-hidden"
          checked={showHidden}
          onChange={(event) => onShowHiddenChange(event.target.checked)}
          style={{ accentColor: "rgb(var(--color-primary))" }}
        />
        show hidden files
      </label>
    </>
  );
}

/** Editable path: Enter navigates, Escape or blur cancels. */
function PathInput({
  initial,
  onSubmit,
  onCancel,
}: {
  initial: string;
  onSubmit: (path: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      data-testid="file-browser-path-input"
      aria-label="Path"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={onCancel}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          const next = draft.trim();
          if (next) onSubmit(next);
          else onCancel();
        } else if (event.key === "Escape") {
          // Prevented so the overlay's window-level Escape leaves it open.
          event.preventDefault();
          onCancel();
        }
      }}
      autoCapitalize="none"
      autoCorrect="off"
      spellCheck={false}
      style={{
        flex: 1,
        minWidth: 0,
        height: 32,
        padding: "0 10px",
        fontFamily: "var(--font-display)",
        fontSize: rem(13),
        color: colors.fg0,
        background: colors.bg0,
        border: `1px solid ${colors.primary}`,
        borderRadius: 4,
        outline: "none",
      }}
    />
  );
}

export function FileBrowserToolbar(props: ToolbarProps) {
  const { touch, crumbs, up, loading, onGo, onRefresh } = props;

  const button = (testId: string, label: string, onClick: () => void, content: React.ReactNode, disabled = false, active = false) => (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      title={label}
      disabled={disabled}
      aria-pressed={active ? true : undefined}
      onClick={onClick}
      style={{ ...toolButtonStyle(touch, active), opacity: disabled ? 0.4 : 1 }}
    >
      {content}
    </button>
  );

  const breadcrumb = props.editingPath && !touch ? (
    <PathInput
      initial={props.currentPath}
      onSubmit={(next) => {
        props.onEditingPathChange(false);
        onGo(next);
      }}
      onCancel={() => props.onEditingPathChange(false)}
    />
  ) : (
    <nav
      aria-label="Path"
      data-testid="file-browser-breadcrumb"
      title={touch ? undefined : "Click to type a path (⌘⇧G)"}
      onClick={(event) => {
        // Empty space after the last crumb turns the path into a text field.
        if (!touch && event.target === event.currentTarget) props.onEditingPathChange(true);
      }}
      style={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        alignItems: "center",
        overflowX: "auto",
        whiteSpace: "nowrap",
        padding: "0 6px",
        minHeight: 32,
        fontSize: rem(13),
        scrollbarWidth: "none",
        cursor: touch ? undefined : "text",
      }}
    >
      {crumbs.map((crumb, index) => {
        const last = index === crumbs.length - 1;
        return (
          <span key={crumb.path} style={{ display: "inline-flex", alignItems: "center" }}>
            {index > 0 && (
              <span aria-hidden style={{ color: colors.fg3 }}>/</span>
            )}
            <button
              type="button"
              data-testid="file-browser-crumb"
              data-path={crumb.path}
              aria-current={last ? "page" : undefined}
              onClick={() => onGo(crumb.path)}
              style={{
                border: "none",
                background: "transparent",
                padding: touch ? "10px 2px" : "3px 2px",
                borderRadius: 3,
                cursor: "pointer",
                fontFamily: "var(--font-display)",
                fontSize: rem(13),
                fontWeight: 400,
                color: last ? colors.fg0 : colors.fg3,
              }}
            >
              {crumb.label}
            </button>
          </span>
        );
      })}
    </nav>
  );

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: touch ? "8px 12px" : "10px 16px",
        borderBottom: `1px solid ${colors.lineSoft}`,
        flexShrink: 0,
      }}
    >
      {!touch && button("file-browser-back", "Back (⌘[)", props.onBack, <ChevronLeft size={16} aria-hidden />, !props.canBack)}
      {!touch && button("file-browser-forward", "Forward (⌘])", props.onForward, <ChevronRight size={16} aria-hidden />, !props.canForward)}
      {button("file-browser-up", "Up one folder", () => up && onGo(up), "↑", !up)}
      {button("file-browser-home", "Home folder", () => onGo("~"), "~")}
      {button(
        "file-browser-refresh",
        "Refresh",
        onRefresh,
        <span aria-hidden style={{ display: "inline-block", ...(loading ? SPIN : {}) }}>↻</span>,
      )}
      {breadcrumb}
      {!touch && (
        <>
          {props.canEdit && props.onNewFolder && button(
            "file-browser-new-folder",
            "New folder (⌘⇧N)",
            props.onNewFolder,
            <FolderPlus size={15} aria-hidden />,
          )}
          {props.canEdit && props.onUpload && button(
            "file-browser-upload",
            "Upload files",
            props.onUpload,
            <Upload size={15} aria-hidden />,
          )}
          {button(
            "file-browser-pin",
            props.pinned ? "Remove from sidebar" : "Pin to sidebar",
            props.onTogglePin,
            <Pin size={14} aria-hidden fill={props.pinned ? "currentColor" : "none"} />,
            false,
            props.pinned,
          )}
          <FileFilterControls {...props} />
          <div role="group" aria-label="View" style={{ display: "inline-flex", gap: 0 }}>
            {(["list", "icons"] as const).map((view) => (
              <button
                key={view}
                type="button"
                data-testid={`file-browser-view-${view}`}
                aria-label={view === "list" ? "List view" : "Icon view"}
                title={view === "list" ? "List view" : "Icon view"}
                aria-pressed={props.view === view}
                onClick={() => props.onViewChange(view)}
                style={{
                  ...toolButtonStyle(false, props.view === view),
                  borderRadius: view === "list" ? "4px 0 0 4px" : "0 4px 4px 0",
                  marginLeft: view === "icons" ? -1 : 0,
                }}
              >
                {view === "list" ? <List size={15} aria-hidden /> : <LayoutGrid size={15} aria-hidden />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
