import { isTauri } from "./platform";

export interface SaveDownloadInput {
  filename: string;
  mime: string;
  dataBase64: string;
}

export interface SavedDownload {
  /** Human-readable place the file ended up. */
  location: string;
  /** Present when the platform can show or open the saved file. */
  open?: () => Promise<void>;
}

interface NativeSaved {
  path: string;
  uri?: string | null;
}

/** Browser-safe file name: no separators or control characters, never empty. */
export function sanitizeFilename(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, "_").trim();
  const name = cleaned.replace(/[. ]+$/, "").replace(/^\s+/, "");
  if (!name || /^\.+$/.test(name)) return "download";
  return name.length > 200 ? name.slice(0, 200) : name;
}

/** Native saving exists on desktop and Android; iOS uses the browser path. */
function hasNativeSave(): boolean {
  if (!isTauri()) return false;
  if (typeof navigator !== "undefined" && /iPhone|iPad|iPod/i.test(navigator.userAgent)) return false;
  return true;
}

function decodeBase64(dataBase64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function saveViaBrowser({ filename, mime, dataBase64 }: SaveDownloadInput): SavedDownload {
  const blob = new Blob([decodeBase64(dataBase64)], { type: mime || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = sanitizeFilename(filename);
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // The download starts asynchronously; keep the URL alive long enough.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return { location: "浏览器下载" };
}

async function saveViaTauri({ filename, mime, dataBase64 }: SaveDownloadInput): Promise<SavedDownload> {
  const { invoke } = await import("@tauri-apps/api/core");
  let saved: NativeSaved;
  try {
    saved = await invoke<NativeSaved>("save_download", {
      filename,
      mime,
      dataBase64,
    });
  } catch (error) {
    // APKs built before the command existed reject with Tauri's
    // "Command save_download not found".
    const text = error instanceof Error ? error.message : String(error);
    if (/save_download/.test(text) && /not found|not allowed|unknown/i.test(text)) {
      throw new Error("需要更新 Offdesk App 才能保存文件");
    }
    throw error;
  }
  return {
    location: saved.path,
    open: () =>
      invoke<void>("open_download", {
        path: saved.path,
        uri: saved.uri ?? null,
        mime,
      }),
  };
}

export async function saveDownloadedFile(input: SaveDownloadInput): Promise<SavedDownload> {
  return hasNativeSave() ? saveViaTauri(input) : saveViaBrowser(input);
}
