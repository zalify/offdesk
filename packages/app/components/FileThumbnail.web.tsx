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

function decode(base64: string, mime: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
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
      const next = URL.createObjectURL(decode(file.data_base64, file.mime));
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
