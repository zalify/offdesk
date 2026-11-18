import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MutableRefObject, PointerEvent as ReactPointerEvent } from "react";
import type { DirEntry } from "@offdesk/shared";
import { listDirectory } from "@/lib/api";
import { FilePreview } from "./FilePreview.web";
import {
  classifyListError,
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
  selectionAfterRemoval,
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
import { showNotice } from "@/lib/workspaceToast";
import { FileBrowserSidebar } from "./FileBrowserSidebar.web";
import { FileBrowserToolbar, FileFilterControls } from "./FileBrowserToolbar.web";
import { selectionOf, setFileClipboard } from "@/lib/fileActions";
import {
  createClickSuppressor,
  FILE_LONG_PRESS_MS,
  FILE_LONG_PRESS_SLOP_PX,
  mobileBarActions,
  mobileMoreActions,
  pasteBarState,
} from "@/lib/fileTouch";
import type { MobileActionId } from "@/lib/fileTouch";
import { useLongPress } from "@/lib/longPress";
import {
  FileActionBar,
  FileAddSheet,
  FilePasteBar,
  FilePlacesSheet,
  FileSelectBar,
  FileSheet,
  FileSheetRow,
} from "./FileMobileUi.web";
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
  // `slow` flips on after SLOW_LOAD_MS so quick loads show no placeholder.
  | { status: "loading"; slow: boolean }
  | { status: "ready"; entries: DirEntry[] }
  | { status: "error"; message: string };

const SLOW_LOAD_MS = 150;

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
  backHandlerRef,
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
  /**
   * Phone: filled with a function the surface's back/close calls first; it
   * closes an open sheet or leaves selection mode and returns true when it did.
   */
  backHandlerRef?: MutableRefObject<(() => boolean) | null>;
}) {
  const [path, setPath] = useState(startPath);
  const [history, setHistory] = useState(() => createHistory(startPath));
  const [showHidden, setShowHidden] = useState(false);
  const [filter, setFilter] = useState("");
  const [listing, setListing] = useState<Listing>({ status: "loading", slow: false });
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
  // Phone: selection mode, the open sheet, and the row a press started on.
  const [selecting, setSelecting] = useState(false);
  const [sheet, setSheet] = useState<"add" | "places" | "more" | null>(null);
  const pressRow = useRef<string | null>(null);
  const [suppressClick] = useState(createClickSuppressor);

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
    setSelecting(false);
    setSheet(null);
    if (touch) setSelection(emptySelection());
    // A clicked row unmounts with the listing; keep keys flowing to the root.
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.hasAttribute("data-row")) {
      rootRef.current?.focus({ preventScroll: true });
    }
  }, [touch]);

  // The start path changes when the terminal opens a directory link while the
  // browser is already open.
  useEffect(() => {
    resetView();
    setPath(startPath);
    setHistory((h) => historyPush(h, startPath));
  }, [startPath, resetView]);

  // Load the listing. Navigation (machine, folder, hidden files) shows a
  // placeholder only if the load is slow; a reload of the same folder swaps the
  // entries in place, so the list keeps its scroll position. A newer request
  // supersedes an older one: its result is dropped when the effect is cleaned up.
  const shownKey = useRef<string | null>(null);
  // Set on navigation; the selection effect starts on the first row once.
  const navigated = useRef(true);
  useEffect(() => {
    let live = true;
    const key = `${machineId}\n${path}\n${showHidden}`;
    const inPlace = shownKey.current === key;
    let slowTimer: ReturnType<typeof setTimeout> | undefined;
    if (!inPlace) {
      shownKey.current = null;
      navigated.current = true;
      setListing({ status: "loading", slow: false });
      slowTimer = setTimeout(() => {
        if (live) setListing((l) => (l.status === "loading" ? { status: "loading", slow: true } : l));
      }, SLOW_LOAD_MS);
    }
    listDirectory(machineId, path, { showHidden })
      .then((entries) => {
        if (!live) return;
        clearTimeout(slowTimer);
        shownKey.current = key;
        setListing({ status: "ready", entries });
        rememberDirectory(machineId, path);
      })
      .catch((err) => {
        if (!live) return;
        clearTimeout(slowTimer);
        const message = describeListError(err, path);
        // A transient failure keeps the list already shown; if the folder itself
        // is gone or closed, that list is stale and the error replaces it.
        const gone = ["not_found", "permission_denied"].includes(classifyListError(err));
        if (inPlace && !gone) showNotice(message, { tone: "error", timeoutMs: 6000 });
        else setListing({ status: "error", message });
      });
    return () => {
      live = false;
      clearTimeout(slowTimer);
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

  // Keep the selection to listed items. A new folder or filter starts on the
  // first row (Enter then opens it); when rows vanish in place (trash, move
  // out) the row now at their index is selected instead.
  const lastFilter = useRef(filter);
  const prevOrder = useRef<string[]>([]);
  useEffect(() => {
    const filterChanged = lastFilter.current !== filter;
    lastFilter.current = filter;
    if (listing.status !== "ready") return;
    const previous = prevOrder.current;
    prevOrder.current = order;
    const fromTop = navigated.current || filterChanged;
    navigated.current = false;
    if (touch) {
      setSelection((current) => (current.selected.size === 0 ? current : pruneSelection(current, order)));
      return;
    }
    setSelection((current) => {
      const pruned = pruneSelection(current, order);
      if (order.length === 0) return pruned;
      if (fromTop) return selectOne(pruned, order[0]);
      if (pruned.selected.size > 0) return pruned;
      const next = selectionAfterRemoval(previous, order, current.selected);
      return next === null ? pruned : selectOne(pruned, next);
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

  // On the phone rows only show a selection while selection mode is on.
  const selected = useMemo(
    () => (touch && !selecting ? new Set<string>() : selection.selected),
    [touch, selecting, selection],
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
    homeDir,
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

  // --- phone: selection mode, action bar, paste bar ---------------------------

  const exitSelecting = useCallback(() => {
    setSelecting(false);
    setSheet(null);
    setSelection(emptySelection());
  }, []);

  const startSelecting = useCallback((entryPath: string) => {
    setSelecting(true);
    setSelection((current) => (current.selected.has(entryPath) ? current : selectionOf([entryPath])));
  }, []);

  const longPress = useLongPress(
    () => {
      const entryPath = pressRow.current;
      if (!entryPath || !order.includes(entryPath)) return;
      suppressClick.arm();
      if (selecting) {
        setSelection((current) =>
          current.selected.has(entryPath) ? current : toggleSelect(current, entryPath),
        );
      } else {
        startSelecting(entryPath);
      }
    },
    touch && listing.status === "ready" && previewPath === null && actions.renaming === null,
    { delayMs: FILE_LONG_PRESS_MS, slopPx: FILE_LONG_PRESS_SLOP_PX },
  );

  const barActions = useMemo(
    () => (touch && selecting ? mobileBarActions({ targets: selectedEntries, canEdit }) : []),
    [touch, selecting, selectedEntries, canEdit],
  );
  const moreActions = mobileMoreActions({
    targets: selectedEntries,
    canEdit,
    canOpenTerminal: !!onOpenTerminal,
    pinned,
  });
  const pasteBar = touch
    ? pasteBarState(actions.clipboard, machineId, path, canEdit)
    : null;

  const runBarAction = (id: MobileActionId) => {
    const targets = selectedEntries;
    const first = targets[0];
    switch (id) {
      case "more":
        setSheet("more");
        return;
      case "download":
        void actions.download(targets);
        break;
      case "move":
        actions.cut(targets);
        break;
      case "copy":
        actions.copy(targets);
        break;
      case "rename":
        if (first) actions.beginRename(first);
        break;
      case "trash":
        void actions.trash(targets);
        break;
      case "duplicate":
        void actions.duplicate(targets);
        break;
      case "copy-path":
        void actions.copyPath(targets);
        break;
      case "open-terminal":
        actions.openInTerminal(targets);
        break;
      case "pin":
        if (first) actions.pinToSidebar(first, pinned.includes(first.path));
        break;
    }
    exitSelecting();
  };

  useEffect(() => {
    if (!backHandlerRef) return;
    backHandlerRef.current = () => {
      if (sheet !== null) {
        setSheet(null);
        return true;
      }
      if (selecting) {
        exitSelecting();
        return true;
      }
      return false;
    };
    return () => {
      backHandlerRef.current = null;
    };
  }, [backHandlerRef, sheet, selecting, exitSelecting]);

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
    selecting: touch && selecting,
    rename: touch
      ? { path: actions.renaming, onCommit: actions.commitRename, onCancel: actions.cancelRename }
      : undefined,
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
      {touch && selecting && (
        <FileSelectBar
          count={selectedEntries.length}
          total={order.length}
          onSelectAll={() => setSelection((current) => selectAll(current, order))}
          onCancel={exitSelecting}
        />
      )}
      {!(touch && selecting) && <FileBrowserToolbar
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
        onAdd={() => setSheet("add")}
        onPlaces={() => setSheet("places")}
      />}
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
            {touch && !selecting && (
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
              onContextMenu={
                touch
                  ? (event) => {
                      // The long-press must not open the system's text menu.
                      if (!(event.target as HTMLElement).closest("input")) event.preventDefault();
                    }
                  : (event) => ix.openMenu(event, visible)
              }
              // The click that ends a long-press must not toggle the new selection.
              onClickCapture={
                touch
                  ? (event) => {
                      if (suppressClick.consume()) {
                        event.preventDefault();
                        event.stopPropagation();
                      }
                    }
                  : undefined
              }
              onPointerDown={
                touch
                  ? (event: ReactPointerEvent<HTMLDivElement>) => {
                      const row = (event.target as HTMLElement).closest<HTMLElement>("[data-row]");
                      pressRow.current = row?.dataset.path ?? null;
                      suppressClick.clear();
                      if (row) longPress.onPointerDown(event);
                    }
                  : undefined
              }
              onPointerMove={touch ? longPress.onPointerMove : undefined}
              onPointerUp={touch ? longPress.onPointerUp : undefined}
              onPointerCancel={touch ? longPress.onPointerCancel : undefined}
              onClick={(event) => {
                // Empty space deselects.
                if (touch) return;
                if (!(event.target as HTMLElement).closest("button, [data-row], input")) {
                  setSelection(emptySelection());
                }
              }}
              style={{ flex: 1, minHeight: 0, overflowY: "auto", overscrollBehavior: "contain" }}
            >
              {listing.status === "loading" && listing.slow && (
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
            {actions.transfer && (
              <FileTransferStrip transfer={actions.transfer} onCancel={actions.cancelTransfer} touch={touch} />
            )}
            {touch && selecting && barActions.length > 0 && (
              <FileActionBar actions={barActions} onAction={runBarAction} />
            )}
            {touch && !selecting && pasteBar?.visible && (
              <FilePasteBar
                state={pasteBar}
                onPaste={() => void actions.paste(path)}
                onCancel={() => setFileClipboard(null)}
              />
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
      {touch && sheet === "add" && (
        <FileAddSheet
          onClose={() => setSheet(null)}
          onNewFolder={() => {
            setSheet(null);
            setFilter("");
            void actions.newFolder();
          }}
          onNewFile={() => {
            setSheet(null);
            setFilter("");
            void actions.newFile();
          }}
          onUpload={() => {
            setSheet(null);
            ix.openUploadPicker();
          }}
        />
      )}
      {touch && sheet === "places" && (
        <FilePlacesSheet
          path={path}
          homeDir={homeDir}
          terminalCwds={terminalCwds ?? []}
          pinned={pinned}
          onGo={go}
          onUnpin={unpin}
          onClose={() => setSheet(null)}
        />
      )}
      {touch && sheet === "more" && (
        <FileSheet title="More" testid="file-browser-more-sheet" onClose={() => setSheet(null)}>
          {moreActions.map((action) => (
            <FileSheetRow
              key={action.id}
              testid={`file-mobile-action-${action.id}`}
              label={action.label}
              onClick={() => runBarAction(action.id)}
            />
          ))}
        </FileSheet>
      )}
      {actions.conflict && <FileConflictDialog prompt={actions.conflict} touch={touch} />}
    </div>
  );
}
