import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { DirEntry } from "@offdesk/shared";
import {
  fsOp,
  readRange,
  RemoteFileError,
  uploadAbort,
  uploadBegin,
  uploadChunk,
  uploadEnd,
  zipPaths,
} from "@/lib/api";
import type { FsConflictPolicy, FsOp } from "@/lib/api";
import {
  conflictName,
  DIRTY_FILE_NOTICE,
  freeDefaultName,
  getFileClipboard,
  setFileClipboard,
  subscribeFileClipboard,
  terminalDirFor,
  touchesDirtyFile,
  trashedNotice,
} from "@/lib/fileActions";
import { isTooLarge } from "@/lib/fileBrowser";
import {
  blobToBase64,
  clipboardAfterPaste,
  describeFsOpError,
  downloadRemote,
  downloadZip,
  isInFolder,
  isAbortError,
  joinPath,
  pasteDecision,
  uploadToDirectory,
  validateName,
} from "@/lib/fileManager";
import { fetchRemoteFile, saveFetchedFile } from "@/lib/fetchRemoteFile";
import { showNotice } from "@/lib/workspaceToast";
import { SpeedMeter, UploadQueue } from "@/lib/uploadQueue";
import type { QueueSnapshot } from "@/lib/uploadQueue";

export interface TransferState {
  kind: "upload" | "download";
  name: string;
  done: number;
  /** 0 while unknown (zip being prepared). */
  total: number;
  /** Files finished when several are queued. */
  filesDone: number;
  count: number;
  /** Smoothed bytes per second (0 while unknown). */
  speedBps: number;
  /** Seconds left, null while unknown. */
  etaSec: number | null;
}

export type ConflictChoice = "keep_both" | "replace" | "stop";

export interface ConflictPrompt {
  name: string;
  /** More items follow, so "apply to all" makes sense. */
  allowAll: boolean;
  resolve: (answer: { choice: ConflictChoice; all: boolean }) => void;
}

export interface FileActionsOptions {
  machineId: string;
  /** Folder being listed. */
  dir: string;
  /** Machine home, to match "~" against the absolute paths the node returns. */
  homeDir?: string;
  /** Mutating actions are refused when false (view-only lock). */
  canEdit: boolean;
  /** Path of the file open in the editor with unsaved changes, if any. */
  dirtyPath: string | null;
  /** Names currently listed (for free default names). */
  listedNames: string[];
  reload: () => void;
  /** Replace the selection with these paths (once they are listed). */
  selectPaths: (paths: string[]) => void;
  pin: (path: string) => void;
  unpin: (path: string) => void;
  onOpenTerminal?: (cwd: string) => void;
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // fall back to a hidden textarea
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  try {
    document.execCommand("copy");
  } finally {
    area.remove();
  }
}

const isExists = (err: unknown): err is RemoteFileError =>
  err instanceof RemoteFileError && err.code === "exists";

/**
 * File actions shared by the desktop (context menu, keys, drag & drop) and the
 * phone (action bar): every action takes the entries it applies to. Errors
 * become notices; nothing here throws.
 */
export function useFileActions(options: FileActionsOptions) {
  const opts = useRef(options);
  opts.current = options;

  const clipboard = useSyncExternalStore(subscribeFileClipboard, getFileClipboard);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [transfer, setTransfer] = useState<TransferState | null>(null);
  const [downloadState, setDownloadState] = useState<TransferState | null>(null);
  const [conflict, setConflict] = useState<ConflictPrompt | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const conflictRef = useRef<ConflictPrompt | null>(null);
  const queueRef = useRef<UploadQueue<File> | null>(null);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Closing the overlay stops running transfers and any pending question.
  useEffect(
    () => () => {
      abortRef.current?.abort();
      queueRef.current?.cancel();
      if (reloadTimer.current) clearTimeout(reloadTimer.current);
      conflictRef.current?.resolve({ choice: "stop", all: false });
    },
    [],
  );

  const askConflict = useCallback(
    (name: string, allowAll: boolean) =>
      new Promise<{ choice: ConflictChoice; all: boolean }>((resolve) => {
        const prompt: ConflictPrompt = {
          name,
          allowAll,
          resolve: (answer) => {
            conflictRef.current = null;
            setConflict(null);
            resolve(answer);
          },
        };
        conflictRef.current = prompt;
        setConflict(prompt);
      }),
    [],
  );

  const canMutate = useCallback((): boolean => {
    if (opts.current.canEdit) return true;
    showNotice("Files are view-only while the view-only lock is on");
    return false;
  }, []);

  const refuseDirty = useCallback((paths: string[]): boolean => {
    if (!touchesDirtyFile(paths, opts.current.dirtyPath)) return false;
    showNotice(DIRTY_FILE_NOTICE);
    return true;
  }, []);

  const fail = useCallback((err: unknown, name?: string) => {
    if (isAbortError(err)) return;
    showNotice(describeFsOpError(err, name), { tone: "error", timeoutMs: 6000 });
  }, []);

  /** Select what an action produced when it landed in the folder being shown. */
  const settle = useCallback((paths: string[]) => {
    const { dir, homeDir, reload, selectPaths } = opts.current;
    reload();
    const here = paths.filter((p) => isInFolder(p, dir, homeDir));
    if (here.length > 0) selectPaths(here);
  }, []);

  // --- create / rename --------------------------------------------------

  const createItem = useCallback(
    async (kind: "folder" | "file") => {
      if (!canMutate()) return;
      const { machineId, dir, listedNames } = opts.current;
      const path = joinPath(dir, freeDefaultName(kind, listedNames));
      try {
        const [created] = await fsOp(
          machineId,
          kind === "folder" ? { op: "mkdir", path } : { op: "create_file", path },
        );
        const target = created ?? path;
        settle([target]);
        setRenaming(target);
      } catch (err) {
        fail(err);
      }
    },
    [canMutate, fail, settle],
  );

  const beginRename = useCallback(
    (entry: DirEntry) => {
      if (!canMutate() || refuseDirty([entry.path])) return;
      setRenaming(entry.path);
    },
    [canMutate, refuseDirty],
  );
  const cancelRename = useCallback(() => setRenaming(null), []);

  /** Resolves to an error message when the name was refused (keep editing), else null. */
  const commitRename = useCallback(
    async (entry: DirEntry, newName: string): Promise<string | null> => {
      if (newName === entry.name) {
        setRenaming(null);
        return null;
      }
      const invalid = validateName(newName);
      if (invalid) {
        showNotice(invalid, { tone: "error" });
        return invalid;
      }
      if (refuseDirty([entry.path])) return DIRTY_FILE_NOTICE;
      try {
        const paths = await fsOp(opts.current.machineId, {
          op: "rename",
          path: entry.path,
          new_name: newName,
        });
        setRenaming(null);
        settle(paths);
        return null;
      } catch (err) {
        const message = describeFsOpError(err, newName);
        if (!isAbortError(err)) showNotice(message, { tone: "error", timeoutMs: 6000 });
        return message;
      }
    },
    [refuseDirty, settle],
  );

  // --- copy / move / paste -----------------------------------------------

  /** copy/move with the conflict dialog; resolves to the resulting paths, or null if stopped/failed. */
  const runTransferOp = useCallback(
    async (
      op: "copy" | "move",
      sources: string[],
      destDir: string,
      first: FsConflictPolicy = "error",
    ): Promise<string[] | null> => {
      let policy = first;
      for (;;) {
        const body: FsOp = { op, sources, dest_dir: destDir, on_conflict: policy };
        try {
          return await fsOp(opts.current.machineId, body);
        } catch (err) {
          if (isExists(err) && policy === "error") {
            const answer = await askConflict(conflictName(err.path, "item"), false);
            if (answer.choice === "stop") return null;
            policy = answer.choice;
            continue;
          }
          fail(err);
          return null;
        }
      }
    },
    [askConflict, fail],
  );

  /** Used by paste and by drag & drop onto a folder. */
  const moveOrCopy = useCallback(
    async (paths: string[], destDir: string, copy: boolean) => {
      if (!canMutate()) return;
      if (!copy && refuseDirty(paths)) return;
      const result = await runTransferOp(copy ? "copy" : "move", paths, destDir);
      if (result) settle(result);
    },
    [canMutate, refuseDirty, runTransferOp, settle],
  );

  const copy = useCallback(
    (entries: DirEntry[]) => {
      if (!canMutate() || entries.length === 0) return;
      setFileClipboard({
        mode: "copy",
        machineId: opts.current.machineId,
        paths: entries.map((e) => e.path),
      });
    },
    [canMutate],
  );

  const cut = useCallback(
    (entries: DirEntry[]) => {
      if (!canMutate() || entries.length === 0) return;
      if (refuseDirty(entries.map((e) => e.path))) return;
      setFileClipboard({
        mode: "cut",
        machineId: opts.current.machineId,
        paths: entries.map((e) => e.path),
      });
    },
    [canMutate, refuseDirty],
  );

  const paste = useCallback(
    async (destDir: string) => {
      const clip = getFileClipboard();
      if (!clip || !canMutate()) return;
      const decision = pasteDecision(clip, opts.current.machineId, destDir);
      if (!decision.ok) {
        showNotice(decision.reason);
        return;
      }
      if (decision.op === "move" && refuseDirty(clip.paths)) return;
      const result = await runTransferOp(decision.op, clip.paths, destDir);
      if (!result) return;
      setFileClipboard(clipboardAfterPaste(clip));
      settle(result);
    },
    [canMutate, refuseDirty, runTransferOp, settle],
  );

  const duplicate = useCallback(
    async (entries: DirEntry[]) => {
      if (!canMutate() || entries.length === 0) return;
      try {
        const paths = await fsOp(opts.current.machineId, {
          op: "copy",
          sources: entries.map((e) => e.path),
          dest_dir: opts.current.dir,
          on_conflict: "keep_both",
        });
        settle(paths);
      } catch (err) {
        fail(err);
      }
    },
    [canMutate, fail, settle],
  );

  const trash = useCallback(
    async (entries: DirEntry[]) => {
      if (!canMutate() || entries.length === 0) return;
      const paths = entries.map((e) => e.path);
      if (refuseDirty(paths)) return;
      try {
        await fsOp(opts.current.machineId, { op: "trash", paths });
        showNotice(trashedNotice(entries));
        opts.current.reload();
      } catch (err) {
        fail(err, entries.length === 1 ? entries[0].name : undefined);
        opts.current.reload();
      }
    },
    [canMutate, fail, refuseDirty],
  );

  // --- misc -----------------------------------------------------------------

  const copyPath = useCallback(async (entries: DirEntry[]) => {
    if (entries.length === 0) return;
    try {
      await copyText(entries.map((e) => e.path).join("\n"));
      showNotice(entries.length === 1 ? "Path copied" : `${entries.length} paths copied`);
    } catch {
      showNotice("Could not copy to the clipboard", { tone: "error" });
    }
  }, []);

  const openInTerminal = useCallback((entries: DirEntry[]) => {
    const { onOpenTerminal, dir } = opts.current;
    onOpenTerminal?.(terminalDirFor(entries, dir));
  }, []);

  const pinToSidebar = useCallback((entry: DirEntry, pinned: boolean) => {
    if (!entry.is_dir) return;
    if (pinned) opts.current.unpin(entry.path);
    else opts.current.pin(entry.path);
  }, []);

  // --- transfers -------------------------------------------------------------

  const uploadTransfer = (snap: QueueSnapshot): TransferState => ({
    kind: "upload",
    name:
      snap.active.length > 1
        ? `${snap.active[0]} +${snap.active.length - 1}`
        : (snap.active[0] ?? ""),
    done: snap.bytesDone,
    total: snap.bytesTotal,
    filesDone: snap.filesDone,
    count: snap.filesTotal,
    speedBps: snap.speedBps,
    etaSec: snap.etaSec,
  });

  /** Reloads the listing shortly after a file lands; bursts share one reload. */
  const scheduleReload = useCallback(() => {
    if (reloadTimer.current) return;
    reloadTimer.current = setTimeout(() => {
      reloadTimer.current = null;
      opts.current.reload();
    }, 300);
  }, []);

  const getQueue = useCallback((): UploadQueue<File> => {
    if (queueRef.current) return queueRef.current;
    const queue = new UploadQueue<File>({
      run: (item, ctx) =>
        uploadToDirectory({
          machineId: opts.current.machineId,
          destDir: item.destDir,
          file: item.file,
          onConflict: ctx.policy,
          signal: ctx.signal,
          api: { uploadBegin, uploadChunk, uploadEnd, uploadAbort },
          onProgress: ctx.onProgress,
        }),
      askConflict,
      onFileDone: (path) => {
        const { dir, homeDir } = opts.current;
        if (isInFolder(path, dir, homeDir)) scheduleReload();
      },
      onChange: (snap) => {
        if (snap.filesTotal > 0) setTransfer(uploadTransfer(snap));
      },
      onDrain: (result) => {
        setTransfer(null);
        if (reloadTimer.current) {
          clearTimeout(reloadTimer.current);
          reloadTimer.current = null;
        }
        const { uploaded, error, cancelled } = result;
        if (uploaded.length > 0) {
          showNotice(`Uploaded ${uploaded.length} ${uploaded.length === 1 ? "file" : "files"}`);
        }
        if (cancelled) showNotice("Upload cancelled");
        else if (error) fail(error);
        // Select what landed only now, so a busy queue never steals the selection.
        settle(uploaded);
      },
    });
    queueRef.current = queue;
    return queue;
  }, [askConflict, fail, scheduleReload, settle]);

  // Speed and time left decay while no progress arrives.
  useEffect(() => {
    if (!transfer || transfer.kind !== "upload") return;
    const timer = setInterval(() => queueRef.current?.tick(), 1000);
    return () => clearInterval(timer);
  }, [transfer !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  const upload = useCallback(
    async (files: File[], destDir: string) => {
      if (files.length === 0 || !canMutate()) return;
      getQueue().add(files.map((file) => ({ file, destDir })));
    },
    [canMutate, getQueue],
  );

  const cancelTransfer = useCallback((kind: "upload" | "download" = "upload") => {
    if (kind === "upload") queueRef.current?.cancel();
    else abortRef.current?.abort();
  }, []);

  const download = useCallback(
    async (entries: DirEntry[]) => {
      if (entries.length === 0) return;
      const { machineId } = opts.current;
      const single = entries.length === 1 ? entries[0] : null;
      // Small single files take the existing fetch path (with its notices).
      if (single && !single.is_dir && !isTooLarge(single)) {
        await fetchRemoteFile({ machineId, path: single.path });
        return;
      }
      // Uploads may run alongside; a second download is refused.
      if (abortRef.current) {
        showNotice("Another download is still running");
        return;
      }
      const controller = new AbortController();
      abortRef.current = controller;
      const signal = controller.signal;
      const label = single?.name ?? `${entries.length} items`;
      const meter = new SpeedMeter();
      const base = { kind: "download", name: label, filesDone: 0, count: 1 } as const;
      const report = (done: number, total: number) => {
        const now = Date.now();
        meter.record(done, now);
        const speedBps = meter.speed(now);
        const left = total - done;
        setDownloadState({
          ...base,
          done,
          total,
          speedBps,
          etaSec: speedBps > 0 && left > 0 ? left / speedBps : null,
        });
      };
      try {
        report(0, single?.size ?? 0);
        let blob: Blob;
        let filename: string;
        if (single && !single.is_dir) {
          blob = await downloadRemote({
            machineId,
            path: single.path,
            size: single.size ?? 0,
            signal,
            api: { readRange },
            onProgress: report,
          });
          filename = single.name;
        } else {
          ({ blob, filename } = await downloadZip({
            machineId,
            paths: entries.map((e) => e.path),
            signal,
            api: { readRange, zipPaths },
            onProgress: report,
          }));
        }
        await saveFetchedFile({
          name: filename,
          mime: single && !single.is_dir ? "application/octet-stream" : "application/zip",
          data_base64: await blobToBase64(blob),
        });
      } catch (err) {
        if (isAbortError(err)) showNotice("Download cancelled");
        else fail(err, single?.name);
      } finally {
        abortRef.current = null;
        setDownloadState(null);
      }
    },
    [fail],
  );

  return {
    clipboard,
    renaming,
    transfer,
    downloadTransfer: downloadState,
    conflict,
    newFolder: useCallback(() => createItem("folder"), [createItem]),
    newFile: useCallback(() => createItem("file"), [createItem]),
    beginRename,
    cancelRename,
    commitRename,
    duplicate,
    copy,
    cut,
    paste,
    trash,
    download,
    copyPath,
    openInTerminal,
    pinToSidebar,
    upload,
    moveOrCopy,
    cancelTransfer,
  };
}

export type FileActions = ReturnType<typeof useFileActions>;
