// Opens an HTML file of a machine as a page, in the app's preview WebView
// (desktop window, Android dialog; see packages/desktop/src-tauri/src/file_preview.rs).
// This page answers that WebView's requests from the machine's files.

import { listDirectory, readFile } from "./api";
import { answerPreviewRequest, previewRoot, previewUrlPath } from "./htmlPreview";
import type { PreviewResponse } from "./htmlPreview";
import { isTauri, isTauriMobile } from "./platform";

type PreviewMessage = { type: "request"; id: number; path: string } | { type: "closed" };

/** The app shell can show it: desktop and Android, not iOS (yet) or a browser. */
export function canPreviewHtml(): boolean {
  if (!isTauri()) return false;
  return !isTauriMobile() || /Android/i.test(navigator.userAgent);
}

export async function openHtmlPreview(machineId: string, path: string, title: string): Promise<void> {
  const { Channel, invoke } = await import("@tauri-apps/api/core");
  const root = await previewRoot(path, (dir) => listDirectory(machineId, dir, { showHidden: true }));
  const requests = new Channel<PreviewMessage>();
  requests.onmessage = (message) => {
    if (message.type !== "request") return;
    void answerPreviewRequest(root, message.path, (file) => readFile(machineId, file)).then(
      (response: PreviewResponse) =>
        invoke("file_preview_respond", { id: message.id, ...response }).catch((err) =>
          console.warn("file preview: could not answer", err),
        ),
    );
  };
  try {
    await invoke("file_preview_open", { title, path: previewUrlPath(path), requests });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // An app from before previews, running this newer web UI.
    if (/not found/i.test(message)) throw new Error("更新 Offdesk App 后才能预览网页");
    throw new Error(`无法打开预览：${message}`);
  }
}
