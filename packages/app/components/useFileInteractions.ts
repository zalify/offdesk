import { useCallback, useMemo, useRef, useState } from "react";
import type { DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import type { DirEntry } from "@offdesk/shared";
import {
  actionTargets,
  buildMenu,
  dropDecision,
  INTERNAL_DRAG_MIME,
  pasteTarget,
} from "@/lib/fileActions";
import type { InternalDrag, MenuActionId, MenuSpec } from "@/lib/fileActions";
import { showNotice } from "@/lib/workspaceToast";
import type { FileActions } from "./useFileActions";

export interface MenuState {
  x: number;
  y: number;
  /** Items the menu applies to; empty for the empty-area menu. */
  targets: DirEntry[];
  specs: MenuSpec[];
}

export interface DropHandlers {
  onDragOver: (event: ReactDragEvent<HTMLElement>) => void;
  onDragLeave: (event: ReactDragEvent<HTMLElement>) => void;
  onDrop: (event: ReactDragEvent<HTMLElement>) => void;
}

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

// What an in-app drag carries; dragover cannot read dataTransfer payloads.
let activeDrag: InternalDrag | null = null;

/** Files from a drop; folders cannot be uploaded and are counted instead. */
function droppedFiles(dt: DataTransfer): { files: File[]; folders: number } {
  const files: File[] = [];
  let folders = 0;
  const items = Array.from(dt.items ?? []);
  if (items.length > 0 && typeof items[0].webkitGetAsEntry === "function") {
    for (const item of items) {
      if (item.kind !== "file") continue;
      if (item.webkitGetAsEntry()?.isDirectory) {
        folders++;
        continue;
      }
      const file = item.getAsFile();
      if (file) files.push(file);
    }
    return { files, folders };
  }
  return { files: Array.from(dt.files), folders };
}

export interface InteractionOptions {
  machineId: string;
  canEdit: boolean;
  dir: string;
  actions: FileActions;
  selectedEntries: DirEntry[];
  showHidden: boolean;
  onShowHiddenChange: (value: boolean) => void;
  pinned: string[];
  canOpenTerminal: boolean;
  reload: () => void;
  selectPaths: (paths: string[]) => void;
  /** Open a file (preview) or folder (navigate). */
  activate: (entry: DirEntry) => void;
  quickLook: (entry: DirEntry) => void;
  /** Called before something is created, so a filter cannot hide the new row. */
  beforeCreate: () => void;
}

/**
 * Desktop interactions on top of the shared actions: context menu, shortcut
 * keys, the upload picker and drag & drop. FileBrowser only wires the returned
 * props into its markup.
 */
export function useFileInteractions(o: InteractionOptions) {
  const o_ = useRef(o);
  o_.current = o;
  const { actions } = o;

  const [menu, setMenu] = useState<MenuState | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const uploadInput = useRef<HTMLInputElement | null>(null);
  const mod = isMac() ? "⌘" : "Ctrl+";

  const openMenu = useCallback(
    (event: ReactMouseEvent, entries: DirEntry[]) => {
      event.preventDefault();
      const { actions: a, canEdit, machineId, dir, canOpenTerminal, showHidden, pinned } = o_.current;
      const row = (event.target as HTMLElement).closest<HTMLElement>("[data-row]");
      const clicked = row ? (entries.find((e) => e.path === row.dataset.path) ?? null) : null;
      const targets = actionTargets(clicked, o_.current.selectedEntries);
      // Like Finder: right-clicking outside the selection selects that item,
      // right-clicking empty space clears the selection.
      if (clicked && targets.length === 1 && targets[0].path === clicked.path) {
        o_.current.selectPaths([clicked.path]);
      } else if (!clicked) {
        o_.current.selectPaths([]);
      }
      const effective = clicked ? targets : [];
      setMenu({
        x: event.clientX,
        y: event.clientY,
        targets: effective,
        specs: buildMenu({
          targets: effective,
          canEdit,
          machineId,
          currentDir: dir,
          clipboard: a.clipboard,
          canOpenTerminal,
          showHidden,
          pinned,
          mod,
        }),
      });
    },
    [mod],
  );
  const closeMenu = useCallback(() => setMenu(null), []);

  const openUploadPicker = useCallback(() => {
    if (!o_.current.canEdit) {
      showNotice("Files are view-only while the view-only lock is on");
      return;
    }
    uploadInput.current?.click();
  }, []);

  const run = useCallback(
    (id: MenuActionId, targets: DirEntry[]) => {
      const cur = o_.current;
      const a = cur.actions;
      const first = targets[0];
      switch (id) {
        case "open":
          if (first) cur.activate(first);
          break;
        case "quicklook":
          if (first) cur.quickLook(first);
          break;
        case "rename":
          if (first) a.beginRename(first);
          break;
        case "duplicate":
          void a.duplicate(targets);
          break;
        case "copy":
          a.copy(targets);
          break;
        case "cut":
          a.cut(targets);
          break;
        case "paste":
          void a.paste(pasteTarget(targets, cur.dir));
          break;
        case "trash":
          void a.trash(targets);
          break;
        case "download":
          void a.download(targets);
          break;
        case "copy-path":
          void a.copyPath(targets);
          break;
        case "open-terminal":
          a.openInTerminal(targets);
          break;
        case "pin":
          if (first) a.pinToSidebar(first, cur.pinned.includes(first.path));
          break;
        case "new-folder":
          cur.beforeCreate();
          void a.newFolder();
          break;
        case "new-file":
          cur.beforeCreate();
          void a.newFile();
          break;
        case "upload":
          openUploadPicker();
          break;
        case "refresh":
          cur.reload();
          break;
        case "show-hidden":
          cur.onShowHiddenChange(!cur.showHidden);
          break;
      }
    },
    [openUploadPicker],
  );

  /** Shortcut keys; true when the event was handled. The caller has ruled out text inputs. */
  const onActionKey = useCallback(
    (event: ReactKeyboardEvent): boolean => {
      const cur = o_.current;
      const sel = cur.selectedEntries;
      const lower = event.key.toLowerCase();
      const command = event.metaKey || event.ctrlKey;
      const handled = (fn: () => void) => {
        event.preventDefault();
        fn();
        return true;
      };
      if (event.key === "F2" && sel.length === 1) return handled(() => run("rename", sel));
      if (event.key === "Delete" || (command && event.key === "Backspace")) {
        return sel.length > 0 ? handled(() => run("trash", sel)) : false;
      }
      if (!command || event.altKey) return false;
      if (lower === "n" && event.shiftKey) return handled(() => run("new-folder", []));
      if (event.shiftKey) return false;
      if (lower === "c" && sel.length > 0) return handled(() => run("copy", sel));
      if (lower === "x" && sel.length > 0) return handled(() => run("cut", sel));
      if (lower === "v") return handled(() => run("paste", []));
      if (lower === "d" && sel.length > 0) return handled(() => run("duplicate", sel));
      return false;
    },
    [run],
  );

  // --- drag & drop -----------------------------------------------------------

  const setHoverTo = useCallback((key: string | null) => setHover((h) => (h === key ? h : key)), []);

  /** Drop handlers for a folder: `key` identifies the highlight, `destDir` is where items land. */
  const dropTarget = useCallback(
    (key: string, destDir: string): DropHandlers => ({
      onDragOver: (event) => {
        const { canEdit, machineId } = o_.current;
        if (!canEdit) return;
        const types = Array.from(event.dataTransfer.types);
        if (activeDrag && types.includes(INTERNAL_DRAG_MIME)) {
          const decision = dropDecision(activeDrag, machineId, destDir, event.altKey);
          if (!decision.ok) return;
          event.dataTransfer.dropEffect = decision.op;
        } else if (types.includes("Files")) {
          event.dataTransfer.dropEffect = "copy";
        } else return;
        event.preventDefault();
        event.stopPropagation();
        setHoverTo(key);
      },
      onDragLeave: (event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setHover((h) => (h === key ? null : h));
      },
      onDrop: (event) => {
        const { canEdit, machineId, actions: a } = o_.current;
        setHover(null);
        if (!canEdit) return;
        const types = Array.from(event.dataTransfer.types);
        if (activeDrag && types.includes(INTERNAL_DRAG_MIME)) {
          const drag = activeDrag;
          const decision = dropDecision(drag, machineId, destDir, event.altKey);
          if (!decision.ok) return;
          event.preventDefault();
          event.stopPropagation();
          activeDrag = null;
          void a.moveOrCopy(drag.paths, destDir, decision.op === "copy");
        } else if (types.includes("Files")) {
          event.preventDefault();
          event.stopPropagation();
          const { files, folders } = droppedFiles(event.dataTransfer);
          if (folders > 0) showNotice("Folders cannot be uploaded yet; drop files");
          void a.upload(files, destDir);
        }
      },
    }),
    [setHoverTo],
  );

  const dragSource = useCallback((entry: DirEntry, renaming: boolean) => {
    const cur = o_.current;
    return {
      draggable: cur.canEdit && !renaming,
      onDragStart: (event: ReactDragEvent<HTMLElement>) => {
        const inSelection = cur.selectedEntries.some((e) => e.path === entry.path);
        const paths = inSelection ? cur.selectedEntries.map((e) => e.path) : [entry.path];
        if (!inSelection) cur.selectPaths(paths);
        activeDrag = { machineId: cur.machineId, paths };
        event.dataTransfer.setData(INTERNAL_DRAG_MIME, JSON.stringify(activeDrag));
        event.dataTransfer.setData("text/plain", paths.join("\n"));
        event.dataTransfer.effectAllowed = "copyMove";
      },
      onDragEnd: () => {
        activeDrag = null;
        setHover(null);
      },
    };
  }, []);

  /** Row-level drag handlers: folders accept drops, every row can be dragged. */
  const rowInteraction = useMemo(
    () => ({
      dropHover: hover,
      dragSource,
      dropTarget: (entry: DirEntry) => dropTarget(`row:${entry.path}`, entry.path),
    }),
    [hover, dragSource, dropTarget],
  );

  return {
    menu,
    openMenu,
    closeMenu,
    run,
    onActionKey,
    uploadInput,
    openUploadPicker,
    hover,
    rowInteraction,
    /** The listing itself as a drop target (current folder). */
    listDrop: dropTarget("list", o.dir),
    /** A sidebar place as a drop target. */
    placeDrop: (path: string) => dropTarget(`place:${path}`, path),
  };
}
