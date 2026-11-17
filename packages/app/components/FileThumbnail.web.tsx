import { useEffect, useRef, useState } from "react";
import type { DirEntry } from "@offdesk/shared";
import { readFile } from "@/lib/api";
import { LruCache } from "@/lib/lruCache";

// Object URLs by machine+path+mtime. Evicted URLs are revoked.
const cache = new LruCache<string>(100, (_key, url) => URL.revokeObjectURL(url));

// At most a few thumbnail reads in flight, so a fast scroll cannot flood the node.
const MAX_INFLIGHT = 4;
let inflight = 0;
const waiting: (() => void)[] = [];
async function withSlot<T>(job: () => Promise<T>): Promise<T> {
  if (inflight >= MAX_INFLIGHT) await new Promise<void>((resolve) => waiting.push(resolve));
  inflight++;
  try {
    return await job();
  } finally {
    inflight--;
    waiting.shift()?.();
  }
}

// Tiles are small: cache a downscaled copy, never the full-size image.
const THUMB_MAX_SIDE = 192;
const SVG_MAX_BYTES = 512 * 1024;

function decode(base64: string, mime: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** Small WebP (PNG if unsupported) of `source`, at most THUMB_MAX_SIDE px per side. */
async function downscale(source: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(source);
  try {
    const scale = Math.min(1, THUMB_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const webp = await toBlob(canvas, "image/webp", 0.8);
    // Browsers without WebP encoding silently hand back a PNG.
    const out = webp?.type === "image/webp" ? webp : await toBlob(canvas, "image/png");
    if (!out) throw new Error("thumbnail encode failed");
    canvas.width = canvas.height = 0; // release the backing store
    return out;
  } finally {
    bitmap.close();
  }
}

/** The blob to cache for a read image; SVGs stay vector but are size-capped. */
async function thumbnailBlob(base64: string, mime: string): Promise<Blob> {
  const full = decode(base64, mime);
  if (mime === "image/svg+xml") {
    if (full.size > SVG_MAX_BYTES) throw new Error("svg too large for a thumbnail");
    return full;
  }
  return downscale(full);
}

/**
 * Lazy image thumbnail: nothing is read until the tile scrolls into view.
 * Renders `fallback` (the kind icon) until the image is ready or if it fails.
 */
export function FileThumbnail({
  machineId,
  entry,
  fallback,
}: {
  machineId: string;
  entry: DirEntry;
  fallback: React.ReactNode;
}) {
  const key = `${machineId}:${entry.path}:${entry.modified_ms ?? 0}`;
  const holder = useRef<HTMLDivElement | null>(null);
  const [url, setUrl] = useState<string | null>(() => cache.get(key) ?? null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    setUrl(cache.get(key) ?? null);
  }, [key]);

  useEffect(() => {
    const el = holder.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (items) => setVisible(items.some((item) => item.isIntersecting)),
      { rootMargin: "100px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || url) return;
    let live = true;
    withSlot(async () => {
      // Scrolled away while queued: skip the read.
      if (!live) return;
      const file = await readFile(machineId, entry.path);
      if (!live) return;
      const small = await thumbnailBlob(file.data_base64, file.mime);
      if (!live) return;
      const next = URL.createObjectURL(small);
      cache.set(key, next);
      setUrl(next);
    }).catch(() => {
      // Keep the icon.
    });
    return () => {
      live = false;
    };
  }, [visible, url, key, machineId, entry.path]);

  return (
    <div
      ref={holder}
      style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}
    >
      {url ? (
        <img
          src={url}
          alt=""
          draggable={false}
          onError={() => setUrl(null)}
          style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
        />
      ) : (
        fallback
      )}
    </div>
  );
}
