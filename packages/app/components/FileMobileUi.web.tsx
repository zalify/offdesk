import { useEffect } from "react";
import type { ReactNode } from "react";
import {
  Copy,
  Download,
  FilePlus,
  Folder,
  FolderPlus,
  Home,
  MoreHorizontal,
  Move,
  Pencil,
  Trash2,
  Upload,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { colors } from "@/lib/colors";
import { buildPlaces } from "./FileBrowserSidebar.web";
import { selectionTitle } from "@/lib/fileTouch";
import type { MobileAction, MobileActionId, PasteBarState } from "@/lib/fileTouch";
import { rem } from "@/lib/rem";
import "./Primitives.css";

const font = "var(--font-display)";

/** A bottom sheet over the file surface (the surface is `position: absolute`). */
export function FileSheet({
  title,
  testid,
  onClose,
  children,
}: {
  title: string;
  testid: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      data-testid={testid}
      onClick={onClose}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 30,
        background: "rgb(0 0 0 / 0.6)",
        display: "flex",
        alignItems: "flex-end",
        animation: "offdeskFadeIn 120ms ease-out",
      }}
    >
      <div
        role="dialog"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
        style={{
          width: "100%",
          maxHeight: "85%",
          display: "flex",
          flexDirection: "column",
          background: colors.bg2,
          borderTop: `1px solid ${colors.line}`,
          borderTopLeftRadius: 16,
          borderTopRightRadius: 16,
          fontFamily: font,
          paddingBottom: "max(10px, env(safe-area-inset-bottom))",
          animation: "offdeskSlideUp 200ms cubic-bezier(0.16, 1, 0.3, 1)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "center", padding: "10px 0 6px", flexShrink: 0 }}>
          <span style={{ width: 40, height: 4, borderRadius: 2, background: colors.line }} />
        </div>
        <div style={{ padding: "4px 16px 10px", fontSize: rem(18), fontWeight: 600, color: colors.fg0, flexShrink: 0 }}>
          {title}
        </div>
        <div style={{ overflowY: "auto", minHeight: 0, paddingBottom: 4 }}>{children}</div>
      </div>
    </div>
  );
}

export function FileSheetRow({
  testid,
  dataPath,
  label,
  detail,
  icon,
  danger,
  active,
  onClick,
}: {
  testid?: string;
  dataPath?: string;
  label: string;
  detail?: string;
  icon?: ReactNode;
  danger?: boolean;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={testid}
      data-path={dataPath}
      data-active={active ? "true" : undefined}
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        width: "100%",
        minHeight: 52,
        padding: "0 20px",
        border: "none",
        background: active ? colors.bg3 : "transparent",
        color: danger ? colors.err : colors.fg0,
        fontFamily: font,
        fontSize: rem(15),
        textAlign: "left",
        cursor: "pointer",
      }}
    >
      {icon && <span aria-hidden style={{ display: "inline-flex", flexShrink: 0, color: colors.fg2 }}>{icon}</span>}
      <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
        {detail && (
          <span style={{ fontSize: rem(11.5), color: colors.fg3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {detail}
          </span>
        )}
      </span>
    </button>
  );
}

/** Header of selection mode: "N selected", Select All, Cancel. */
export function FileSelectBar({
  count,
  total,
  onSelectAll,
  onCancel,
}: {
  count: number;
  total: number;
  onSelectAll: () => void;
  onCancel: () => void;
}) {
  const textBtn = {
    minHeight: 44,
    padding: "0 12px",
    border: "none",
    background: "transparent",
    color: colors.primary,
    fontFamily: font,
    fontSize: rem(14),
    cursor: "pointer",
  } as const;
  return (
    <div
      data-testid="file-browser-select-bar"
      style={{
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: 4,
        padding: "0 4px",
        borderBottom: `1px solid ${colors.lineSoft}`,
        background: colors.bg1,
      }}
    >
      <button type="button" data-testid="file-browser-select-cancel" onClick={onCancel} style={{ ...textBtn, color: colors.fg1 }}>
        Cancel
      </button>
      <div
        role="status"
        data-testid="file-browser-select-count"
        style={{ flex: 1, textAlign: "center", fontFamily: font, fontSize: rem(14), fontWeight: 600, color: colors.fg0 }}
      >
        {selectionTitle(count)}
      </div>
      <button
        type="button"
        data-testid="file-browser-select-all"
        onClick={onSelectAll}
        disabled={total === 0 || count === total}
        style={{ ...textBtn, opacity: total === 0 || count === total ? 0.4 : 1 }}
      >
        Select All
      </button>
    </div>
  );
}

const ACTION_ICONS: Partial<Record<MobileActionId, LucideIcon>> = {
  download: Download,
  move: Move,
  copy: Copy,
  rename: Pencil,
  trash: Trash2,
  more: MoreHorizontal,
};

/** Sticky bottom action bar: icon over a short label, 44px+ targets. */
export function FileActionBar({
  actions,
  onAction,
}: {
  actions: MobileAction[];
  onAction: (id: MobileActionId) => void;
}) {
  return (
    <div
      data-testid="file-browser-action-bar"
      role="toolbar"
      aria-label="File actions"
      style={{
        flexShrink: 0,
        display: "flex",
        borderTop: `1px solid ${colors.line}`,
        background: colors.bg1,
        paddingBottom: "env(safe-area-inset-bottom)",
      }}
    >
      {actions.map((action) => {
        const Icon = ACTION_ICONS[action.id] ?? MoreHorizontal;
        return (
          <button
            key={action.id}
            type="button"
            data-testid={`file-mobile-action-${action.id}`}
            onClick={() => onAction(action.id)}
            style={{
              flex: 1,
              minWidth: 0,
              minHeight: 56,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 3,
              padding: "6px 2px",
              border: "none",
              background: "transparent",
              color: action.danger ? colors.err : colors.fg1,
              fontFamily: font,
              fontSize: rem(11),
              cursor: "pointer",
            }}
          >
            <Icon size={20} aria-hidden />
            <span>{action.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** After Move/Copy: navigate to the destination, then "Paste N items here". */
export function FilePasteBar({
  state,
  onPaste,
  onCancel,
}: {
  state: PasteBarState;
  onPaste: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      data-testid="file-browser-paste-bar"
      style={{
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 12px max(8px, env(safe-area-inset-bottom))",
        borderTop: `1px solid ${colors.line}`,
        background: colors.bg1,
      }}
    >
      <button
        type="button"
        data-testid="file-browser-paste-cancel"
        onClick={onCancel}
        className="odk-btn odk-btn--secondary"
        style={{ height: 44, flexShrink: 0 }}
      >
        Cancel
      </button>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", alignItems: "stretch", gap: 2 }}>
        <button
          type="button"
          data-testid="file-browser-paste"
          disabled={!state.ok}
          onClick={onPaste}
          className="odk-btn odk-btn--primary"
          style={{ height: 44, width: "100%" }}
        >
          {state.label}
        </button>
        {state.reason && (
          <span data-testid="file-browser-paste-reason" style={{ textAlign: "center", fontFamily: font, fontSize: rem(11), color: colors.fg3 }}>
            {state.verb}: {state.reason}
          </span>
        )}
      </div>
    </div>
  );
}

/** The "+" sheet content: New Folder, New File, Upload. */
export function FileAddSheet({
  onNewFolder,
  onNewFile,
  onUpload,
  onClose,
}: {
  onNewFolder: () => void;
  onNewFile: () => void;
  onUpload: () => void;
  onClose: () => void;
}) {
  return (
    <FileSheet title="Add" testid="file-browser-add-sheet" onClose={onClose}>
      <FileSheetRow testid="file-add-new-folder" label="New Folder" icon={<FolderPlus size={20} />} onClick={onNewFolder} />
      <FileSheetRow testid="file-add-new-file" label="New File" icon={<FilePlus size={20} />} onClick={onNewFile} />
      <FileSheetRow testid="file-add-upload" label="Upload" icon={<Upload size={20} />} onClick={onUpload} />
    </FileSheet>
  );
}


/** Places: Home, open terminals' folders and pinned folders (the desktop sidebar's list). */
export function FilePlacesSheet({
  path,
  homeDir,
  terminalCwds,
  pinned,
  onGo,
  onUnpin,
  onClose,
}: {
  path: string;
  homeDir?: string;
  terminalCwds: string[];
  pinned: string[];
  onGo: (path: string) => void;
  onUnpin: (path: string) => void;
  onClose: () => void;
}) {
  const places = buildPlaces(homeDir, terminalCwds, pinned);
  return (
    <FileSheet title="Places" testid="file-browser-places-sheet" onClose={onClose}>
      {places.map((place) => {
        const active = place.path === path || (place.kind === "home" && !!homeDir && path === homeDir);
        const Icon = place.kind === "home" ? Home : Folder;
        return (
          <div key={place.key} style={{ display: "flex", alignItems: "center" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <FileSheetRow
                testid="file-browser-place"
                dataPath={place.path}
                label={place.label}
                detail={place.kind === "terminal" ? `terminal · ${place.path}` : place.kind === "pinned" ? place.path : undefined}
                icon={<Icon size={20} />}
                active={active}
                onClick={() => onGo(place.path)}
              />
            </div>
            {place.kind === "pinned" && (
              <button
                type="button"
                data-testid="file-browser-unpin"
                aria-label={`Unpin ${place.label}`}
                onClick={() => onUnpin(place.path)}
                style={{ width: 48, height: 52, flexShrink: 0, border: "none", background: "transparent", color: colors.fg3, cursor: "pointer", fontSize: rem(18) }}
              >
                ×
              </button>
            )}
          </div>
        );
      })}
    </FileSheet>
  );
}
