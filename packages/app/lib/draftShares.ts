// Pure helpers for the draft share / version-history UI.
import type { DraftShareAsset } from "./api";

export const EXPIRY_OPTIONS: { label: string; days: number | null }[] = [
  { label: "never", days: null },
  { label: "1 day", days: 1 },
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
];

/** Shortens a string to at most `max` chars by replacing the middle with an ellipsis. */
export function truncateMiddle(text: string, max: number): string {
  if (max < 3 || text.length <= max) return text;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${text.slice(0, head)}…${tail > 0 ? text.slice(text.length - tail) : ""}`;
}

function span(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return "<1m";
  const mins = Math.floor(sec / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

export function relativeAgo(ms: number, now = Date.now()): string {
  const diff = now - ms;
  if (diff < 60_000) return "just now";
  return `${span(diff)} ago`;
}

export function expiryLabel(expiresAt: number | null, now = Date.now()): string {
  if (expiresAt === null) return "never expires";
  if (expiresAt <= now) return "expired";
  return `expires in ${span(expiresAt - now)}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export interface AssetsSummary {
  total: number;
  included: number;
  failed: { source: string; reason: string }[];
  headline: string;
}

export function summarizeAssets(assets: DraftShareAsset[] | undefined | null): AssetsSummary {
  const list = assets ?? [];
  const included = list.filter((a) => a.ok).length;
  const failed = list
    .filter((a) => !a.ok)
    .map((a) => ({ source: a.source, reason: a.reason?.trim() || "unknown error" }));
  return {
    total: list.length,
    included,
    failed,
    headline: `${included} ${included === 1 ? "image" : "images"} included`,
  };
}
