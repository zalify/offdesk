// Helpers for forwarding image/file uploads to a terminal session via the
// `image_paste` WS protocol. Pure utilities so they can be unit-tested
// without spinning up xterm or a WebSocket.

// Keep filenames in basename-shape (no path traversal) and stripped of
// control bytes. Falls back to a synthetic `tc-paste-<ts><ext>` name.
export function safeFilename(name: string, fallbackExt = ""): string {
  const base = (name || "").split(/[/\\]/).pop() || "";
  const stripped = base.replace(/^\.+/, "").replace(/[\x00-\x1f]/g, "");
  if (stripped) return stripped;
  return `tc-paste-${Date.now()}${fallbackExt}`;
}

// Read a Blob as base64 plus the resolved MIME type. Uses Blob.arrayBuffer
// rather than FileReader so the helper is testable under plain Node.
export async function readFileAsBase64(
  file: Blob,
): Promise<{ base64: string; mime: string }> {
  const buffer = await file.arrayBuffer();
  const base64 = arrayBufferToBase64(buffer);
  return { base64, mime: file.type || "application/octet-stream" };
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  // Chunk to stay clear of String.fromCharCode argument limits on large
  // payloads (Safari trips around ~100 KB if we feed bytes in one shot).
  // btoa is available in browsers and Node 16+, no fallback needed.
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, Array.from(chunk));
  }
  return btoa(binary);
}

// The file travels Base64-encoded in one JSON message, and the hub, the
// machine and the encrypted channel all cap a message at 32 MiB. 23 MiB
// encodes to ~30.7 MiB, leaving room for the envelope; 25 MiB would not fit.
export const MAX_IMAGE_PASTE_BYTES = 23 * 1024 * 1024;

export interface ImagePasteMessage {
  type: "image_paste";
  data: string;
  mime: string;
  filename: string;
}

export function buildImagePasteMessage(
  base64: string,
  mime: string,
  filename: string,
): ImagePasteMessage {
  return { type: "image_paste", data: base64, mime, filename };
}

// Mobile browsers (notably Android Chrome) suspend the page when a file
// picker is in the foreground, which often closes the live WebSocket. The
// `change` event then fires before the reconnect lands, so a naive
// `readyState === OPEN` check silently drops the upload. Poll the supplied
// reader so we pick up the new socket once reconnect creates it.
export async function waitForWsOpen(
  read: () => WebSocket | null | undefined,
  timeoutMs: number,
  pollMs = 100,
  now: () => number = () => Date.now(),
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<WebSocket | null> {
  const deadline = now() + timeoutMs;
  while (true) {
    const ws = read();
    if (ws && ws.readyState === WebSocket.OPEN) return ws;
    if (now() >= deadline) return null;
    await sleep(pollMs);
  }
}
