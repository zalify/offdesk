// Chunked, flow-controlled file upload over the per-terminal attach WS
// (docs/plans/2026-11-04-chunked-uploads.md). Pure: the caller supplies
// `send` and `subscribe`, so this runs under plain Node in tests.
import { arrayBufferToBase64, MAX_IMAGE_PASTE_BYTES, safeFilename } from "./terminalImagePaste";

export const UPLOAD_CHUNK_BYTES = 1024 * 1024;

export class UploadError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "UploadError";
    this.code = code;
  }
}

export interface UploadOptions {
  file: Blob & { name?: string };
  send: (text: string) => void;
  subscribe: (listener: (text: string) => void) => () => void;
  onProgress?: (sent: number, total: number) => void;
  chunkBytes?: number;
  beginTimeoutMs?: number;
  replyTimeoutMs?: number;
}

type Reply =
  | { type: "upload_progress"; received: number }
  | { type: "upload_result"; path: string; size: number };

function newUploadId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export async function uploadFileChunked(options: UploadOptions): Promise<{ path: string; size: number }> {
  const { file, send, subscribe, onProgress } = options;
  const chunkBytes = options.chunkBytes ?? UPLOAD_CHUNK_BYTES;
  const beginTimeoutMs = options.beginTimeoutMs ?? 5000;
  const replyTimeoutMs = options.replyTimeoutMs ?? 30000;
  const uploadId = newUploadId();
  const total = file.size;

  // Replies arrive via one listener; `waiter` is the single outstanding wait.
  let waiter: { resolve: (r: Reply) => void; reject: (e: unknown) => void } | null = null;
  const queue: Array<Reply | UploadError> = [];
  const deliver = (item: Reply | UploadError) => {
    if (waiter) {
      const w = waiter;
      waiter = null;
      if (item instanceof UploadError) w.reject(item); else w.resolve(item);
    } else queue.push(item);
  };
  const unsubscribe = subscribe((text) => {
    let msg: { type?: string; upload_id?: string; received?: number; path?: string; size?: number; code?: string; message?: string };
    try { msg = JSON.parse(text); } catch { return; }
    if (!msg || msg.upload_id !== uploadId) return;
    if (msg.type === "upload_progress") deliver({ type: "upload_progress", received: Number(msg.received) || 0 });
    else if (msg.type === "upload_result") deliver({ type: "upload_result", path: String(msg.path ?? ""), size: Number(msg.size) || 0 });
    else if (msg.type === "upload_error") deliver(new UploadError(msg.code ?? "io", msg.message || "Upload failed."));
  });

  const next = (timeoutMs: number, timeoutCode: string): Promise<Reply> => new Promise((resolve, reject) => {
    const queued = queue.shift();
    if (queued) { if (queued instanceof UploadError) reject(queued); else resolve(queued); return; }
    const timer = setTimeout(() => {
      waiter = null;
      reject(new UploadError(timeoutCode, timeoutCode === "no_reply"
        ? "The hub did not answer the upload request."
        : "The upload stalled: no reply from the node."));
    }, timeoutMs);
    waiter = {
      resolve: (r) => { clearTimeout(timer); resolve(r); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    };
  });
  const post = (message: Record<string, unknown>) => send(JSON.stringify({ ...message, upload_id: uploadId }));

  try {
    const mime = file.type || "application/octet-stream";
    const ext = mime.includes("/") ? `.${mime.split("/")[1]}` : "";
    post({ type: "upload_begin", filename: safeFilename(file.name ?? "", ext), mime, size: total });
    let reply = await next(beginTimeoutMs, "no_reply");
    if (reply.type === "upload_progress") onProgress?.(reply.received, total);

    let index = 0;
    for (let offset = 0; offset < total; offset += chunkBytes, index++) {
      // One chunk in memory at a time.
      const buffer = await file.slice(offset, Math.min(offset + chunkBytes, total)).arrayBuffer();
      post({ type: "upload_chunk", index, data: arrayBufferToBase64(buffer) });
      reply = await next(replyTimeoutMs, "reply_timeout");
      if (reply.type === "upload_progress") onProgress?.(reply.received, total);
    }

    post({ type: "upload_end" });
    for (;;) {
      reply = await next(replyTimeoutMs, "reply_timeout");
      if (reply.type === "upload_result") return { path: reply.path, size: reply.size };
    }
  } catch (error) {
    if (error instanceof UploadError && error.code === "reply_timeout") {
      try { post({ type: "upload_abort" }); } catch { /* socket already gone */ }
    }
    throw error;
  } finally {
    unsubscribe();
  }
}

// An old hub/node drops upload_* silently (no_reply) or answers `outdated`;
// files that still fit one image_paste message can use that path instead.
export function uploadFallsBackToLegacy(error: unknown, fileSize: number): boolean {
  return error instanceof UploadError
    && (error.code === "no_reply" || error.code === "outdated")
    && fileSize <= MAX_IMAGE_PASTE_BYTES;
}
