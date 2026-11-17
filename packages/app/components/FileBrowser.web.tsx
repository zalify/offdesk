import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { DirEntry } from "@offdesk/shared";
import { listDirectory } from "@/lib/api";
import { FilePreview } from "./FilePreview.web";
import {
  describeListError,
  filterEntries,
  isTooLarge,
  parentPath,
  rememberDirectory,
  splitBreadcrumb,
} from "@/lib/fileBrowser";
import {
  canBack,
  canForward,
  createHistory,
  DEFAULT_VIEW_PREFS,
  emptySelection,
  historyBack,
  historyCurrent,
  historyForward,
  historyPush,
  moveFocus,
  pinFolder,
  pinnedFolders,
  pruneSelection,
  selectAll,
  selectOne,
  selectRange,
  setViewPrefs,
  sortEntries,
  toggleSelect,
  unpinFolder,
  viewPrefs,
} from "@/lib/fileManager";
import type { Selection, SortKey, ViewPrefs } from "@/lib/fileManager";
import { gridMoveDelta } from "@/lib/fileGrid";
import type { ArrowKey } from "@/lib/fileGrid";
import { colors } from "@/lib/colors";
import { FileBrowserSidebar } from "./FileBrowserSidebar.web";
import { FileBrowserToolbar, FileFilterControls } from "./FileBrowserToolbar.web";
import { selectionOf } from "@/lib/fileActions";
import { FileActionMenu } from "./FileActionMenu.web";
import { FileConflictDialog, FileTransferStrip } from "./FileTransferUi.web";
import { useFileActions } from "./useFileActions";
import { useFileInteractions } from "./useFileInteractions";
import { FileIconView } from "./FileIconView.web";
import { FileListView } from "./FileListView.web";
import { FileStatusBar } from "./FileStatusBar.web";
import { Centered, SPIN } from "./FileBrowserShared.web";
import type { ClickModifiers, RowInteraction } from "./FileRowEvents";

type Listing =
  | { status: "loading" }
  | { status: "ready"; entries: DirEntry[] }
  | { status: "error"; message: string };

const isMod = (event: ReactKeyboardEvent) => event.metaKey || event.ctrlKey;
const ARROWS = new Set<string>(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

/**
 * The remote file browser core, shared by the desktop overlay and the phone's
 * full-screen surface. Desktop is a Finder-like window (sidebar, toolbar with
 * history and an editable path, list or icon view, multi-selection, status
 * bar); the phone keeps single-tap rows. A file opens in an in-place preview.
 *
 * File actions (context menu, shortcut keys, inline rename, drag & drop,
 * transfers) live in useFileActions / useFileInteractions; `selection` /
 * `selectedEntries` say what they apply to and `reload()` refreshes the list.
 */
export function FileBrowser({
  machineId,
  homeDir,
  startPath,
  touch,
  canEdit = false,
  terminalCwds,
  onDirtyChange,
  onOpenTerminal,
}: {
  machineId: string;
  homeDir?: string;
  startPath: string;
  /** Phone surface: 44px rows, no keyboard navigation, no sidebar. */
  touch: boolean;
  /** Text files may be edited (not under the view-only lock). */
  canEdit?: boolean;
  /** Working directories of this machine's open terminals (sidebar entries). */
  terminalCwds?: string[];
  /** Whether an open editor holds unsaved changes. */
  onDirtyChange?: (dirty: boolean) => void;
  /** Start a terminal in a folder ("Open in Terminal"); omitted when not allowed. */
  onOpenTerminal?: (cwd: string) => void;
}) {
  const [path, setPath] = useState(startPath);
  const [history, setHistory] = useState(() => createHistory(startPath));
  const [showHidden, setShowHidden] = useState(false);
  const [filter, setFilter] = useState("");
  const [listing, setListing] = useState<Listing>({ status: "loading" });
  const [selection, setSelection] = useState<Selection>(emptySelection);
  const [prefs, setPrefs] = useState<ViewPrefs>(() => viewPrefs(machineId));
  const [pinned, setPinned] = useState<string[]>(() => pinnedFolders(machineId));
  const [editingPath, setEditingPath] = useState(false);
  // The file being previewed in place of the listing; null shows the listing.
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const listScroll = useRef(0);
  const [reloadTick, setReloadTick] = useState(0);
  const [dirty, setDirty] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const filterRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const columnsRef = useRef(1);

  // The phone always shows the plain name-sorted list.
  const effective = touch ? DEFAULT_VIEW_PREFS : prefs;

  useEffect(() => {
    setPrefs(viewPrefs(machineId));
    setPinned(pinnedFolders(machineId));
  }, [machineId]);

  const resetView = useCallback(() => {
    setFilter("");
    setPreviewPath(null);
    setEditingPath(false);
    // A clicked row unmounts with the listing; keep keys flowing to the root.
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.hasAttribute("data-row")) {
      rootRef.current?.focus({ preventScroll: true });
    }
  }, []);

  // The start path changes when the terminal opens a directory link while the
  // browser is already open.
  useEffect(() => {
    resetView();
    setPath(startPath);
    setHistory((h) => historyPush(h, startPath));
  }, [startPath, resetView]);

  // Load the listing. A newer navigation or toggle supersedes an older
  // request: its result is dropped when the effect has been cleaned up.
  useEffect(() => {
    let live = true;
    setListing({ status: "loading" });
    listDirectory(machineId, path, { showHidden })
      .then((entries) => {
        if (!live) return;
        setListing({ status: "ready", entries });
        rememberDirectory(machineId, path);
      })
      .catch((err) => {
        if (!live) return;
        setListing({ status: "error", message: describeListError(err, path) });
      });
    return () => {
      live = false;
    };
  }, [machineId, path, showHidden, reloadTick]);

  const visible = useMemo(
    () =>
      listing.status === "ready"
        ? filterEntries(sortEntries(listing.entries, effective.sort), filter)
        : [],
    [listing, filter, effective.sort],
  );
  const order = useMemo(() => visible.map((e) => e.path), [visible]);

  // Keep the selection to listed items; a new folder or filter starts on the
  // first row (Enter then opens it).
  const lastFilter = useRef(filter);
  useEffect(() => {
    const filterChanged = lastFilter.current !== filter;
    lastFilter.current = filter;
    if (touch || listing.status !== "ready") return;
    setSelection((current) => {
      const pruned = pruneSelection(current, order);
      if (order.length === 0) return pruned;
      if (filterChanged || pruned.selected.size === 0) return selectOne(pruned, order[0]);
      return pruned;
    });
  }, [order, filter, listing.status, touch]);

  const focusName = visible.find((e) => e.path === selection.focus)?.name;
  useEffect(() => {
    if (focusName === undefined) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-row][data-name="${CSS.escape(focusName)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [focusName]);

  useEffect(() => {
    if (!touch) rootRef.current?.focus({ preventScroll: true });
  }, [touch]);

  const crumbs = useMemo(() => splitBreadcrumb(path, homeDir), [path, homeDir]);
  const up = parentPath(path, homeDir);

  const go = useCallback(
    (next: string) => {
      resetView();
      setPath(next);
      setHistory((h) => historyPush(h, next));
    },
    [resetView],
  );

  const stepHistory = useCallback(
    (back: boolean) => {
      const next = back ? historyBack(history) : historyForward(history);
      if (next === history) return;
      resetView();
      setHistory(next);
      setPath(historyCurrent(next));
    },
    [history, resetView],
  );

  const setColumns = useCallback((columns: number) => {
    columnsRef.current = columns;
  }, []);
  const reload = useCallback(() => setReloadTick((n) => n + 1), []);
  const pin = useCallback((p: string) => setPinned(pinFolder(machineId, p)), [machineId]);
  const unpin = useCallback((p: string) => setPinned(unpinFolder(machineId, p)), [machineId]);

  const setSort = useCallback(
    (key: SortKey) => {
      setPrefs((current) => {
        const dir = current.sort.key === key && current.sort.dir === "asc" ? "desc" : "asc";
        const next = { ...current, sort: { key, dir } } as ViewPrefs;
        setViewPrefs(machineId, next);
        return next;
      });
    },
    [machineId],
  );
  const setView = useCallback(
    (view: ViewPrefs["view"]) => {
      setPrefs((current) => {
        const next = { ...current, view };
        setViewPrefs(machineId, next);
        return next;
      });
    },
    [machineId],
  );

  const openPreview = useCallback((entry: DirEntry) => {
    if (listRef.current) listScroll.current = listRef.current.scrollTop;
    setPreviewPath(entry.path);
  }, []);

  const closePreview = useCallback(() => {
    setPreviewPath(null);
    if (!touch) rootRef.current?.focus({ preventScroll: true });
  }, [touch]);

  const activate = useCallback(
    (entry: DirEntry) => {
      if (entry.is_dir) {
        go(entry.path);
        return;
      }
      if (isTooLarge(entry)) return;
      openPreview(entry);
    },
    [go, openPreview],
  );

  const selectEntry = useCallback(
    (entry: DirEntry, mods: ClickModifiers) => {
      setSelection((current) =>
        mods.range
          ? selectRange(current, order, entry.path)
          : mods.toggle
            ? toggleSelect(current, entry.path)
            : selectOne(current, entry.path),
      );
    },
    [order],
  );

  const selected = useMemo(
    () => (touch ? new Set<string>() : selection.selected),
    [touch, selection],
  );
  const selectedEntries = useMemo(
    () => visible.filter((e) => selection.selected.has(e.path)),
    [visible, selection],
  );

  const trackDirty = useCallback(
    (value: boolean) => {
      setDirty(value);
      onDirtyChange?.(value);
    },
    [onDirtyChange],
  );

  const listedNames = useMemo(
    () => (listing.status === "ready" ? listing.entries.map((e) => e.name) : []),
    [listing],
  );
  const selectPaths = useCallback((paths: string[]) => setSelection(selectionOf(paths)), []);
  const actions = useFileActions({
    machineId,
    dir: path,
    canEdit,
    dirtyPath: dirty ? previewPath : null,
    listedNames,
    reload,
    selectPaths,
    pin,
    unpin,
    onOpenTerminal,
  });
  const ix = useFileInteractions({
    machineId,
    canEdit,
    dir: path,
    actions,
    selectedEntries,
    showHidden,
    onShowHiddenChange: setShowHidden,
    pinned,
    canOpenTerminal: !!onOpenTerminal,
    reload,
    selectPaths,
    activate,
    quickLook: (entry) => {
      if (!entry.is_dir && !isTooLarge(entry)) openPreview(entry);
    },
    beforeCreate: () => setFilter(""),
  });

  // The renamed row unmounts with its input; keep keys flowing to the root.
  const renamingNow = actions.renaming !== null;
  useEffect(() => {
    if (renamingNow || touch) return;
    const active = document.activeElement;
    if (!active || active === document.body) rootRef.current?.focus({ preventScroll: true });
  }, [renamingNow, touch]);

  const interaction: RowInteraction | undefined = touch
    ? undefined
    : {
        renamingPath: actions.renaming,
        onRenameCommit: actions.commitRename,
        onRenameCancel: actions.cancelRename,
        ...ix.rowInteraction,
      };

  // Files that prev/next can step through: the visible, previewable ones.
  const previewable = useMemo(
    () => visible.filter((e) => !e.is_dir && !isTooLarge(e)),
    [visible],
  );
  const previewIndex = previewable.findIndex((e) => e.path === previewPath);
  const previewEntry =
    previewIndex >= 0
      ? previewable[previewIndex]
      : (listing.status === "ready"
          ? listing.entries.find((e) => e.path === previewPath)
          : undefined);

  const stepPreview = useCallback(
    (delta: number) => {
      const target = previewable[previewIndex + delta];
      if (!target) return;
      setPreviewPath(target.path);
      setSelection((current) => selectOne(current, target.path));
    },
    [previewable, previewIndex],
  );
  const onPrev = previewIndex > 0 ? () => stepPreview(-1) : undefined;
  const onNext =
    previewIndex >= 0 && previewIndex < previewable.length - 1
      ? () => stepPreview(1)
      : undefined;

  // The row that had focus unmounts with the listing; keep keys flowing to the
  // browser root, and put the scroll position back when returning.
  useEffect(() => {
    if (previewPath !== null && !touch) rootRef.current?.focus({ preventScroll: true });
  }, [previewPath === null, touch]);
  useLayoutEffect(() => {
    if (previewPath === null && listRef.current) {
      listRef.current.scrollTop = listScroll.current;
    }
  }, [previewPath === null]);

  const moveSelection = (key: ArrowKey, extend: boolean) => {
    const columns = effective.view === "icons" ? columnsRef.current : 1;
    const cur = selection.focus !== null ? order.indexOf(selection.focus) : -1;
    let delta: number;
    if (cur < 0) delta = key === "ArrowUp" || key === "ArrowLeft" ? -1 : 1;
    else {
      delta = gridMoveDelta(cur, key, columns, order.length);
      if (delta === 0) return;
    }
    setSelection(moveFocus(selection, order, delta, extend));
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (touch || event.defaultPrevented) return;
    const target = event.target as HTMLElement;
    const key = event.key;
    const lower = key.toLowerCase();

    // ⌘⇧G / ⌘L / Ctrl+L: type a path.
    if (isMod(event) && (lower === "l" || (lower === "g" && event.shiftKey))) {
      event.preventDefault();
      setEditingPath(true);
      return;
    }
    if (target.getAttribute("data-testid") === "file-browser-path-input") return;

    if (previewPath !== null) {
      // Handled (and prevented) here so the overlay's window-level Escape
      // listener sees defaultPrevented and leaves the overlay open.
      if (key === "Escape" || (key === "Backspace" && target !== filterRef.current)) {
        event.preventDefault();
        closePreview();
      } else if (key === "ArrowLeft") {
        event.preventDefault();
        onPrev?.();
      } else if (key === "ArrowRight") {
        event.preventDefault();
        onNext?.();
      }
      return;
    }

    const inFilter = target === filterRef.current;
    const inInput = target.tagName === "INPUT" || target.tagName === "TEXTAREA";

    if (!inInput && ix.onActionKey(event)) return;

    if (isMod(event) && (key === "[" || key === "]")) {
      event.preventDefault();
      stepHistory(key === "[");
    } else if (event.altKey && !inInput && (key === "ArrowLeft" || key === "ArrowRight")) {
      event.preventDefault();
      stepHistory(key === "ArrowLeft");
    } else if (isMod(event) && lower === "a" && !inInput) {
      event.preventDefault();
      setSelection((current) => selectAll(current, order));
    } else if (key === "ArrowUp" && event.altKey) {
      event.preventDefault();
      if (up) go(up);
    } else if (ARROWS.has(key) && !event.altKey && !isMod(event) && (!inInput || inFilter)) {
      // Left/right move the filter's caret, not the selection.
      if (inFilter && (key === "ArrowLeft" || key === "ArrowRight")) return;
      event.preventDefault();
      moveSelection(key as ArrowKey, event.shiftKey);
    } else if (key === "Enter") {
      if (target.tagName === "BUTTON" && !target.hasAttribute("data-row")) return;
      if (inInput && !inFilter) return;
      const entry = visible.find((e) => e.path === selection.focus);
      if (entry) {
        event.preventDefault();
        activate(entry);
      }
    } else if (key === " " && !inInput && !(target.tagName === "BUTTON" && !target.hasAttribute("data-row"))) {
      // Space: Quick Look, the in-place preview, for the focused file.
      event.preventDefault();
      const entry = visible.find((e) => e.path === selection.focus);
      if (entry && !entry.is_dir && !isTooLarge(entry)) openPreview(entry);
    } else if (key === "Backspace" && (!inFilter || filter === "")) {
      if (inInput && !inFilter) return;
      event.preventDefault();
      if (up) go(up);
    } else if (key === "Escape" && inFilter && filter !== "") {
      event.preventDefault();
      setFilter("");
    } else if (
      !inFilter &&
      key.length === 1 &&
      key !== " " &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !inInput
    ) {
      // Typing anywhere in the list starts filtering.
      filterRef.current?.focus();
    }
  };

  const filterProps = {
    touch,
    filter,
    onFilterChange: setFilter,
    filterRef,
    showHidden,
    onShowHiddenChange: setShowHidden,
  };

  const viewProps = {
    entries: visible,
    selected,
    onSelect: selectEntry,
    onOpen: activate,
    interaction,
  };

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      data-testid="file-browser"
      data-path={path}
      onKeyDown={onKeyDown}
      // A file dropped outside a target must not navigate the page to it.
      onDragOver={(event) => {
        if (!event.defaultPrevented && event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDrop={(event) => {
        if (!event.defaultPrevented && event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      style={{
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        outline: "none",
        color: colors.fg0,
        background: "transparent",
        fontFamily: "var(--font-display)",
      }}
    >
      <FileBrowserToolbar
        {...filterProps}
        crumbs={crumbs}
        up={up}
        loading={listing.status === "loading"}
        canBack={canBack(history)}
        canForward={canForward(history)}
        onBack={() => stepHistory(true)}
        onForward={() => stepHistory(false)}
        onGo={go}
        onRefresh={reload}
        editingPath={editingPath}
        onEditingPathChange={setEditingPath}
        currentPath={path}
        pinned={pinned.includes(path)}
        onTogglePin={() => (pinned.includes(path) ? unpin(path) : pin(path))}
        view={effective.view}
        onViewChange={setView}
        canEdit={canEdit}
        onNewFolder={() => {
          setFilter("");
          void actions.newFolder();
        }}
        onUpload={ix.openUploadPicker}
      />
      <input
        ref={ix.uploadInput}
        type="file"
        multiple
        hidden
        data-testid="file-browser-upload-input"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          void actions.upload(files, path);
        }}
      />

      {/* Sidebar, then the list and the open file side by side on the desktop
          (D08); on the phone the preview takes the whole surface (P08). */}
      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        {!touch && (
          <FileBrowserSidebar
            path={path}
            homeDir={homeDir}
            terminalCwds={terminalCwds ?? []}
            pinned={pinned}
            onGo={go}
            onUnpin={unpin}
            placeDrop={canEdit ? ix.placeDrop : undefined}
            dropHover={ix.hover}
          />
        )}
        {(previewPath === null || !touch) && (
          <div
            style={{
              flex: previewPath !== null ? "0 0 380px" : 1,
              minWidth: 0,
              minHeight: 0,
              display: "flex",
              flexDirection: "column",
              borderRight: previewPath !== null ? `1px solid ${colors.lineSoft}` : "none",
            }}
          >
            {touch && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "8px 12px",
                  borderBottom: `1px solid ${colors.lineSoft}`,
                  flexShrink: 0,
                }}
              >
                <FileFilterControls {...filterProps} />
              </div>
            )}

            <div
              ref={listRef}
              data-testid="file-browser-list"
              className="odk-fb-list"
              data-drop={ix.hover === "list" ? "true" : undefined}
              {...(touch ? {} : ix.listDrop)}
              onContextMenu={touch ? undefined : (event) => ix.openMenu(event, visible)}
              onClick={(event) => {
                // Empty space deselects.
                if (touch) return;
                if (!(event.target as HTMLElement).closest("button, [data-row], input")) {
                  setSelection(emptySelection());
                }
              }}
              style={{ flex: 1, minHeight: 0, overflowY: "auto", overscrollBehavior: "contain" }}
            >
              {listing.status === "loading" && (
                <Centered testId="file-browser-loading">
                  <span aria-hidden style={{ display: "inline-block", ...SPIN }}>↻</span> reading…
                </Centered>
              )}
              {listing.status === "error" && (
                <Centered testId="file-browser-error" color={colors.danger}>
                  <div role="alert" style={{ marginBottom: 10 }}>
                    {listing.message}
                  </div>
                  <button
                    type="button"
                    data-testid="file-browser-retry"
                    onClick={reload}
                    className="odk-btn odk-btn--secondary odk-btn--sm"
                  >
                    try again
                  </button>
                </Centered>
              )}
              {listing.status === "ready" && visible.length === 0 && (
                <Centered testId="file-browser-empty">
                  {filter ? "No files match" : "This folder is empty"}
                </Centered>
              )}
              {listing.status === "ready" && visible.length > 0 && effective.view === "icons" && !touch && (
                <FileIconView
                  {...viewProps}
                  machineId={machineId}
                  onColumnsChange={setColumns}
                />
              )}
              {listing.status === "ready" && visible.length > 0 && (effective.view === "list" || touch) && (
                <FileListView {...viewProps} touch={touch} sort={effective.sort} onSort={setSort} />
              )}
            </div>
            {!touch && actions.transfer && (
              <FileTransferStrip transfer={actions.transfer} onCancel={actions.cancelTransfer} />
            )}
            {!touch && listing.status === "ready" && (
              <FileStatusBar total={visible.length} selected={selectedEntries} />
            )}
          </div>
        )}
        {previewPath !== null && (
          <FilePreview
            key={previewPath}
            machineId={machineId}
            path={previewPath}
            name={previewEntry?.name ?? previewPath.split("/").pop() ?? previewPath}
            size={previewEntry?.size}
            touch={touch}
            canEdit={canEdit}
            onBack={closePreview}
            onPrev={onPrev}
            onNext={onNext}
            onDirtyChange={trackDirty}
          />
        )}
      </div>
      {ix.menu && (
        <FileActionMenu
          x={ix.menu.x}
          y={ix.menu.y}
          specs={ix.menu.specs}
          onAction={(id) => ix.run(id, ix.menu?.targets ?? [])}
          onClose={ix.closeMenu}
        />
      )}
      {actions.conflict && <FileConflictDialog prompt={actions.conflict} />}
    </div>
  );
}
