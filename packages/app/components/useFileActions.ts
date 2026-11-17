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
  dirname,
  downloadRemote,
  downloadZip,
  isAbortError,
  joinPath,
  pasteDecision,
  uploadToDirectory,
  validateName,
} from "@/lib/fileManager";
import { fetchRemoteFile, saveFetchedFile } from "@/lib/fetchRemoteFile";
import { showNotice } from "@/lib/workspaceToast";

export interface TransferState {
  kind: "upload" | "download";
  name: string;
  done: number;
  /** 0 while unknown (zip being prepared). */
  total: number;
  /** 1-based position when several files are queued. */
  index: number;
  count: number;
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
  const [conflict, setConflict] = useState<ConflictPrompt | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const conflictRef = useRef<ConflictPrompt | null>(null);

  // Closing the overlay stops a running transfer and any pending question.
  useEffect(
    () => () => {
      abortRef.current?.abort();
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
    showNotice("Files are view-only while another device controls this session");
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
    const { dir, reload, selectPaths } = opts.current;
    reload();
    const here = paths.filter((p) => dirname(p) === dir);
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

  const beginTransfer = useCallback((): AbortController | null => {
    if (abortRef.current) {
      showNotice("Another transfer is still running");
      return null;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    return controller;
  }, []);

  const endTransfer = useCallback(() => {
    abortRef.current = null;
    setTransfer(null);
  }, []);

  const cancelTransfer = useCallback(() => abortRef.current?.abort(), []);

  const upload = useCallback(
    async (files: File[], destDir: string) => {
      if (files.length === 0 || !canMutate()) return;
      const controller = beginTransfer();
      if (!controller) return;
      const { machineId } = opts.current;
      const uploaded: string[] = [];
      let applyToAll: FsConflictPolicy | null = null;
      let stopped = false;
      try {
        for (let i = 0; i < files.length && !stopped; i++) {
          const file = files[i];
          const base = { kind: "upload", name: file.name, total: file.size, index: i + 1, count: files.length } as const;
          setTransfer({ ...base, done: 0 });
          let policy: FsConflictPolicy = applyToAll ?? "error";
          for (;;) {
            try {
              const result = await uploadToDirectory({
                machineId,
                destDir,
                file,
                onConflict: policy,
                signal: controller.signal,
                api: { uploadBegin, uploadChunk, uploadEnd, uploadAbort },
                onProgress: (sent) => setTransfer({ ...base, done: sent }),
              });
              uploaded.push(result.path);
              break;
            } catch (err) {
              if (isExists(err) && policy === "error") {
                const answer = await askConflict(file.name, files.length - i > 1);
                if (answer.choice === "stop") {
                  stopped = true;
                  break;
                }
                policy = answer.choice;
                if (answer.all) applyToAll = answer.choice;
                continue;
              }
              throw err;
            }
          }
        }
        if (uploaded.length > 0) {
          showNotice(`Uploaded ${uploaded.length} ${uploaded.length === 1 ? "file" : "files"}`);
        }
      } catch (err) {
        if (isAbortError(err)) showNotice("Upload cancelled");
        else fail(err);
      } finally {
        endTransfer();
        settle(uploaded);
      }
    },
    [askConflict, beginTransfer, canMutate, endTransfer, fail, settle],
  );

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
      const controller = beginTransfer();
      if (!controller) return;
      const signal = controller.signal;
      const label = single?.name ?? `${entries.length} items`;
      const base = { kind: "download", name: label, index: 1, count: 1 } as const;
      try {
        setTransfer({ ...base, done: 0, total: single?.size ?? 0 });
        let blob: Blob;
        let filename: string;
        if (single && !single.is_dir) {
          blob = await downloadRemote({
            machineId,
            path: single.path,
            size: single.size ?? 0,
            signal,
            api: { readRange },
            onProgress: (done, total) => setTransfer({ ...base, done, total }),
          });
          filename = single.name;
        } else {
          ({ blob, filename } = await downloadZip({
            machineId,
            paths: entries.map((e) => e.path),
            signal,
            api: { readRange, zipPaths },
            onProgress: (done, total) => setTransfer({ ...base, done, total }),
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
        endTransfer();
      }
    },
    [beginTransfer, endTransfer, fail],
  );

  return {
    clipboard,
    renaming,
    transfer,
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
