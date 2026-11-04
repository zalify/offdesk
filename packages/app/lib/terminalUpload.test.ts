import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { arrayBufferToBase64, MAX_IMAGE_PASTE_BYTES } from "./terminalImagePaste";
import { UploadError, uploadFallsBackToLegacy, uploadFileChunked } from "./terminalUpload";

function makeHub(opts: { auto?: boolean } = {}) {
  const auto = opts.auto ?? true;
  const sent: Array<Record<string, any>> = [];
  const listeners = new Set<(t: string) => void>();
  let received = 0;
  const emit = (m: object) => { for (const l of Array.from(listeners)) l(JSON.stringify(m)); };
  const send = (text: string) => {
    const m = JSON.parse(text);
    sent.push(m);
    if (!auto) return;
    // Reply asynchronously like a real socket.
    queueMicrotask(() => {
      if (m.type === "upload_begin") emit({ type: "upload_progress", upload_id: m.upload_id, received: 0 });
      else if (m.type === "upload_chunk") {
        received += atob(m.data).length;
        emit({ type: "upload_progress", upload_id: m.upload_id, received });
      } else if (m.type === "upload_end") emit({ type: "upload_result", upload_id: m.upload_id, path: "/tmp/x/a.bin", size: received });
    });
  };
  const subscribe = (l: (t: string) => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
  return { sent, send, subscribe, emit, listeners };
}

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function bytesOf(n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + 7) & 0xff;
  return b;
}
function fileOf(bytes: Uint8Array, name = "a.bin"): Blob & { name: string } {
  return Object.assign(new Blob([bytes as BlobPart], { type: "application/octet-stream" }), { name });
}

describe("uploadFileChunked", () => {
  it("sends 3 chunks in order and round-trips the bytes", async () => {
    const hub = makeHub();
    const bytes = bytesOf(250);
    const progress: Array<[number, number]> = [];
    const result = await uploadFileChunked({
      file: fileOf(bytes), send: hub.send, subscribe: hub.subscribe, chunkBytes: 100,
      onProgress: (s, t) => progress.push([s, t]),
    });
    expect(result).toEqual({ path: "/tmp/x/a.bin", size: 250 });
    expect(hub.sent.map((m) => m.type)).toEqual(["upload_begin", "upload_chunk", "upload_chunk", "upload_chunk", "upload_end"]);
    expect(hub.sent[0]).toMatchObject({ filename: "a.bin", size: 250 });
    const chunks = hub.sent.filter((m) => m.type === "upload_chunk");
    expect(chunks.map((c) => c.index)).toEqual([0, 1, 2]);
    expect(new Set(hub.sent.map((m) => m.upload_id)).size).toBe(1);
    const joined = chunks.map((c) => atob(c.data)).join("");
    expect(btoa(joined)).toBe(arrayBufferToBase64(bytes.buffer as ArrayBuffer));
    expect(progress).toEqual([[0, 250], [100, 250], [200, 250], [250, 250]]);
    expect(hub.listeners.size).toBe(0);
  });

  it("waits for progress before sending the next chunk", async () => {
    const hub = makeHub({ auto: false });
    const p = uploadFileChunked({ file: fileOf(bytesOf(250)), send: hub.send, subscribe: hub.subscribe, chunkBytes: 100 });
    const id = () => hub.sent[0].upload_id;
    await flush();
    expect(hub.sent.map((m) => m.type)).toEqual(["upload_begin"]);
    hub.emit({ type: "upload_progress", upload_id: id(), received: 0 });
    await flush();
    expect(hub.sent.filter((m) => m.type === "upload_chunk").length).toBe(1);
    await flush();
    expect(hub.sent.filter((m) => m.type === "upload_chunk").length).toBe(1);
    hub.emit({ type: "upload_progress", upload_id: id(), received: 100 });
    await flush();
    expect(hub.sent.filter((m) => m.type === "upload_chunk").length).toBe(2);
    hub.emit({ type: "upload_progress", upload_id: id(), received: 200 });
    await flush();
    hub.emit({ type: "upload_progress", upload_id: id(), received: 250 });
    await flush();
    expect(hub.sent[hub.sent.length - 1].type).toBe("upload_end");
    hub.emit({ type: "upload_result", upload_id: id(), path: "/p", size: 250 });
    await expect(p).resolves.toEqual({ path: "/p", size: 250 });
  });

  it("ignores replies for another upload_id", async () => {
    const hub = makeHub({ auto: false });
    const p = uploadFileChunked({ file: fileOf(bytesOf(10)), send: hub.send, subscribe: hub.subscribe, chunkBytes: 100 });
    await flush();
    const id = hub.sent[0].upload_id;
    hub.emit({ type: "upload_error", upload_id: "other", code: "io", message: "nope" });
    hub.emit({ type: "upload_progress", upload_id: "other", received: 0 });
    await flush();
    expect(hub.sent.length).toBe(1);
    hub.emit({ type: "upload_progress", upload_id: id, received: 0 });
    await flush();
    hub.emit({ type: "upload_progress", upload_id: id, received: 10 });
    await flush();
    hub.emit({ type: "upload_result", upload_id: id, path: "/q", size: 10 });
    await expect(p).resolves.toEqual({ path: "/q", size: 10 });
  });

  it("surfaces hub errors with their code", async () => {
    const hub = makeHub({ auto: false });
    const p = uploadFileChunked({ file: fileOf(bytesOf(10)), send: hub.send, subscribe: hub.subscribe });
    await flush();
    hub.emit({ type: "upload_error", upload_id: hub.sent[0].upload_id, code: "too_large", message: "File too large" });
    const err = await p.catch((e) => e);
    expect(err).toBeInstanceOf(UploadError);
    expect(err.code).toBe("too_large");
    expect(err.message).toBe("File too large");
    expect(hub.listeners.size).toBe(0);
  });

  describe("timeouts", () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it("rejects with no_reply when begin is never answered", async () => {
      const hub = makeHub({ auto: false });
      const p = uploadFileChunked({ file: fileOf(bytesOf(10)), send: hub.send, subscribe: hub.subscribe });
      const assertion = expect(p).rejects.toMatchObject({ code: "no_reply" });
      await vi.advanceTimersByTimeAsync(5000);
      await assertion;
      expect(hub.sent.some((m) => m.type === "upload_abort")).toBe(false);
      expect(hub.listeners.size).toBe(0);
    });

    it("rejects with reply_timeout and sends upload_abort when a chunk stalls", async () => {
      const hub = makeHub({ auto: false });
      const p = uploadFileChunked({ file: fileOf(bytesOf(10)), send: hub.send, subscribe: hub.subscribe });
      const assertion = expect(p).rejects.toMatchObject({ code: "reply_timeout" });
      await vi.advanceTimersByTimeAsync(0);
      hub.emit({ type: "upload_progress", upload_id: hub.sent[0].upload_id, received: 0 });
      await vi.advanceTimersByTimeAsync(0);
      expect(hub.sent.map((m) => m.type)).toEqual(["upload_begin", "upload_chunk"]);
      await vi.advanceTimersByTimeAsync(30000);
      await assertion;
      expect(hub.sent[hub.sent.length - 1].type).toBe("upload_abort");
    });
  });
});

describe("uploadFallsBackToLegacy", () => {
  const small = 1024;
  const big = MAX_IMAGE_PASTE_BYTES + 1;
  it("is true for no_reply/outdated on files that fit one message", () => {
    expect(uploadFallsBackToLegacy(new UploadError("no_reply", ""), small)).toBe(true);
    expect(uploadFallsBackToLegacy(new UploadError("outdated", ""), MAX_IMAGE_PASTE_BYTES)).toBe(true);
  });
  it("is false for big files, other codes and non-upload errors", () => {
    expect(uploadFallsBackToLegacy(new UploadError("no_reply", ""), big)).toBe(false);
    expect(uploadFallsBackToLegacy(new UploadError("outdated", ""), big)).toBe(false);
    expect(uploadFallsBackToLegacy(new UploadError("io", ""), small)).toBe(false);
    expect(uploadFallsBackToLegacy(new UploadError("reply_timeout", ""), small)).toBe(false);
    expect(uploadFallsBackToLegacy(new Error("x"), small)).toBe(false);
  });
});
