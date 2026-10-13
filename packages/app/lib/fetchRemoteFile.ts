import { readFile as apiReadFile, RemoteFileError } from "./api";
import type { RemoteFile } from "./api";
import { saveDownloadedFile } from "./saveDownload";
import type { SavedDownload } from "./saveDownload";
import { baseName } from "./remoteFileLinks";
import { showNotice } from "./workspaceToast";
import type { NoticeAction } from "./workspaceToast";

export const MAX_FETCH_BYTES = 20 * 1024 * 1024;

export interface FetchRemoteFileOptions {
  machineId: string;
  path: string;
  /**
   * Tried when `path` does not exist. A path joined across terminal rows
   * may have taken in the next row's first word; this is the part without it.
   */
  fallbackPath?: string;
  cwd?: string;
  /** Called with the resolved path when the target turns out to be a directory. */
  onDirectory?: (resolvedPath: string) => void;
}

export interface FetchRemoteFileDeps {
  read: (machineId: string, path: string, cwd?: string) => Promise<RemoteFile>;
  save: (input: {
    filename: string;
    mime: string;
    dataBase64: string;
  }) => Promise<SavedDownload>;
  notify: (
    message: string,
    opts?: { action?: NoticeAction; timeoutMs?: number; tone?: "info" | "error" },
  ) => void;
}

const defaultDeps: FetchRemoteFileDeps = {
  read: apiReadFile,
  save: saveDownloadedFile,
  notify: showNotice,
};

const inFlight = new Set<string>();

function formatMb(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;
}

export function describeFetchError(err: unknown, path: string): string {
  const name = baseName(path);
  if (err instanceof RemoteFileError) {
    switch (err.code) {
      case "too_large":
        return err.size
          ? `${name} is ${formatMb(err.size)}, over the ${formatMb(MAX_FETCH_BYTES)} limit`
          : `${name} is over the ${formatMb(MAX_FETCH_BYTES)} limit`;
      case "not_found":
        return `${name} not found`;
      case "machine_not_found":
        return "Machine not found";
      case "permission_denied":
        return `No permission to read ${name}`;
      case "machine_outdated":
        return "This machine's node is too old to fetch files. Update it first.";
      case "machine_disconnected":
        return "The machine disconnected, so the file could not be fetched";
      case "timeout":
        return `Fetching ${name} timed out; the machine did not respond`;
      case "bad_request":
        return `Could not fetch ${name}: invalid path`;
      default:
        if (err.status === 504) return `Fetching ${name} timed out; the machine did not respond`;
        return `Could not fetch ${name}: ${err.message}`;
    }
  }
  const message = err instanceof Error ? err.message : String(err);
  return `Could not fetch ${name}: ${message}`;
}

/**
 * Saves an already-loaded remote file on this device and announces it
 * ("Saved … → …" with an "open" action when the platform supports it). Errors
 * become toasts; this never throws.
 */
export async function saveFetchedFile(
  file: Pick<RemoteFile, "name" | "mime" | "data_base64">,
  deps: Pick<FetchRemoteFileDeps, "save" | "notify"> = defaultDeps,
): Promise<void> {
  try {
    const saved = await deps.save({
      filename: file.name,
      mime: file.mime,
      dataBase64: file.data_base64,
    });
    const open = saved.open;
    deps.notify(
      `Saved ${file.name} → ${saved.location}`,
      open
        ? {
            action: {
              label: "open",
              run: () => {
                void open().catch((err) =>
                  deps.notify(
                    `Could not open it: ${err instanceof Error ? err.message : String(err)}`,
                    { tone: "error" },
                  ),
                );
              },
            },
          }
        : undefined,
    );
  } catch (err) {
    deps.notify(
      `Could not save ${file.name}: ${err instanceof Error ? err.message : String(err)}`,
      { tone: "error", timeoutMs: 8000 },
    );
  }
}

const isNotFound = (err: unknown) =>
  err instanceof RemoteFileError && err.code === "not_found";

async function readWithFallback(
  deps: FetchRemoteFileDeps,
  machineId: string,
  path: string,
  fallbackPath: string | undefined,
  cwd: string | undefined,
): Promise<RemoteFile> {
  try {
    return await deps.read(machineId, path, cwd);
  } catch (err) {
    if (!fallbackPath || !isNotFound(err)) throw err;
    try {
      return await deps.read(machineId, fallbackPath, cwd);
    } catch (fallbackErr) {
      // Neither exists: report the path as shown.
      throw isNotFound(fallbackErr) ? err : fallbackErr;
    }
  }
}

/**
 * Fetches a file from a remote machine and saves it on this device, with
 * visible progress / success / error notices. Concurrent calls for the same
 * file are ignored.
 */
export async function fetchRemoteFile(
  options: FetchRemoteFileOptions,
  deps: FetchRemoteFileDeps = defaultDeps,
): Promise<void> {
  const { machineId, path, fallbackPath, cwd, onDirectory } = options;
  const key = `${machineId}\0${cwd ?? ""}\0${path}`;
  if (inFlight.has(key)) return;
  inFlight.add(key);
  const name = baseName(path);
  try {
    deps.notify(`Fetching ${name}…`, { timeoutMs: 0 });
    let file: RemoteFile;
    try {
      file = await readWithFallback(deps, machineId, path, fallbackPath, cwd);
    } catch (err) {
      if (err instanceof RemoteFileError && err.code === "is_directory") {
        const resolved = err.path ?? path;
        if (onDirectory) {
          deps.notify(`${baseName(resolved) || resolved} is a folder`, { timeoutMs: 1500 });
          onDirectory(resolved);
        } else {
          deps.notify(`${baseName(resolved) || resolved} is a folder and cannot be fetched`, {
            tone: "error",
          });
        }
        return;
      }
      deps.notify(describeFetchError(err, path), { tone: "error", timeoutMs: 8000 });
      return;
    }
    await saveFetchedFile(file, deps);
  } finally {
    inFlight.delete(key);
  }
}
