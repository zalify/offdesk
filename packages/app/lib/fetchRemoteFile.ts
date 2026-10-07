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
          ? `${name} 有 ${formatMb(err.size)}，超过 ${formatMb(MAX_FETCH_BYTES)} 上限`
          : `${name} 超过 ${formatMb(MAX_FETCH_BYTES)} 上限`;
      case "not_found":
        return `找不到 ${name}`;
      case "machine_not_found":
        return "找不到这台机器";
      case "permission_denied":
        return `没有权限读取 ${name}`;
      case "machine_outdated":
        return "这台机器的 node 版本太旧，升级后才能取文件";
      case "machine_disconnected":
        return "机器已断开连接，无法取文件";
      case "timeout":
        return `取 ${name} 超时，机器没有响应`;
      case "bad_request":
        return `无法取 ${name}：路径无效`;
      default:
        if (err.status === 504) return `取 ${name} 超时，机器没有响应`;
        return `取 ${name} 失败：${err.message}`;
    }
  }
  const message = err instanceof Error ? err.message : String(err);
  return `取 ${name} 失败：${message}`;
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
  const { machineId, path, cwd, onDirectory } = options;
  const key = `${machineId}\0${cwd ?? ""}\0${path}`;
  if (inFlight.has(key)) return;
  inFlight.add(key);
  const name = baseName(path);
  try {
    deps.notify(`正在取 ${name}…`, { timeoutMs: 0 });
    let file: RemoteFile;
    try {
      file = await deps.read(machineId, path, cwd);
    } catch (err) {
      if (err instanceof RemoteFileError && err.code === "is_directory") {
        const resolved = err.path ?? path;
        if (onDirectory) {
          deps.notify(`${baseName(resolved) || resolved} 是目录`, { timeoutMs: 1500 });
          onDirectory(resolved);
        } else {
          deps.notify(`${baseName(resolved) || resolved} 是目录，不能直接取`, {
            tone: "error",
          });
        }
        return;
      }
      deps.notify(describeFetchError(err, path), { tone: "error", timeoutMs: 8000 });
      return;
    }
    try {
      const saved = await deps.save({
        filename: file.name,
        mime: file.mime,
        dataBase64: file.data_base64,
      });
      const open = saved.open;
      deps.notify(
        `已保存 ${file.name} → ${saved.location}`,
        open
          ? {
              action: {
                label: "打开",
                run: () => {
                  void open().catch((err) =>
                    deps.notify(
                      `打开失败：${err instanceof Error ? err.message : String(err)}`,
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
        `保存 ${file.name} 失败：${err instanceof Error ? err.message : String(err)}`,
        { tone: "error", timeoutMs: 8000 },
      );
    }
  } finally {
    inFlight.delete(key);
  }
}
