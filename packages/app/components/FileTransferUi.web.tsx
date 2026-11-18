import { useEffect, useRef, useState } from "react";
import { colors, colorAlpha } from "@/lib/colors";
import { formatBytes } from "@/lib/resourceStats";
import { rem } from "@/lib/rem";
import { formatEta } from "@/lib/uploadQueue";
import "./Primitives.css";
import type { ConflictChoice, ConflictPrompt, TransferState } from "./useFileActions";

/** Keeps the start and the extension: "a-very-long-na…me.tar.gz". */
function midTruncate(name: string, max: number): string {
  if (name.length <= max) return name;
  const tail = Math.floor((max - 1) / 3);
  return `${name.slice(0, max - 1 - tail)}…${name.slice(name.length - tail)}`;
}

/**
 * Slim progress strip above the status bar: current file, "3 of 10 files",
 * overall bytes, speed, time left and a cancel that stops the whole queue.
 * The phone gets one line plus the bar.
 */
export function FileTransferStrip({
  transfer,
  onCancel,
  touch = false,
}: {
  transfer: TransferState;
  onCancel: () => void;
  /** Phone: tighter padding and a 44px cancel target. */
  touch?: boolean;
}) {
  const known = transfer.total > 0;
  const pct = known ? Math.min(100, Math.round((transfer.done / transfer.total) * 100)) : null;
  const verb = transfer.kind === "upload" ? "Uploading" : "Downloading";
  const files =
    transfer.count > 1
      ? touch
        ? `${transfer.filesDone}/${transfer.count}`
        : `${transfer.filesDone} of ${transfer.count} files`
      : "";
  const label = touch ? midTruncate(transfer.name, 28) : `${verb} ${transfer.name}`;
  const bytes =
    pct !== null
      ? `${pct}% · ${formatBytes(transfer.done)} of ${formatBytes(transfer.total)}`
      : transfer.kind === "download"
        ? "preparing…"
        : "";
  const speed = transfer.speedBps > 0 ? `${formatBytes(transfer.speedBps)}/s` : "";
  const eta = transfer.etaSec !== null && transfer.speedBps > 0 ? `${formatEta(transfer.etaSec)} left` : "";
  const muted = { flexShrink: 0, color: colors.fg3, whiteSpace: "nowrap" } as const;
  return (
    <div
      data-testid="file-browser-transfer"
      data-kind={transfer.kind}
      role="status"
      style={{
        flexShrink: 0,
        position: "relative",
        display: "flex",
        alignItems: "center",
        gap: touch ? 8 : 12,
        padding: touch ? "0 4px 0 12px" : "6px 20px",
        borderTop: `1px solid ${colors.lineSoft}`,
        background: colors.bg1,
        fontSize: rem(12),
        color: colors.fg2,
        fontFamily: "var(--font-display)",
      }}
    >
      <span
        aria-hidden
        data-testid="file-browser-transfer-bar"
        data-pct={pct ?? ""}
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          height: 2,
          width: `${pct ?? 100}%`,
          background: colors.primary,
          opacity: pct === null ? 0.35 : 1,
          transition: "width 120ms linear",
        }}
      />
      <span
        data-testid="file-browser-transfer-name"
        style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: colors.fg1 }}
      >
        {label}
      </span>
      {files && (
        <span data-testid="file-browser-transfer-files" style={muted}>
          {files}
        </span>
      )}
      {!touch && (
        <span data-testid="file-browser-transfer-progress" style={muted}>
          {bytes}
        </span>
      )}
      {touch && pct !== null && (
        <span data-testid="file-browser-transfer-progress" style={muted}>
          {pct}%
        </span>
      )}
      {speed && (
        <span data-testid="file-browser-transfer-speed" style={muted}>
          {speed}
        </span>
      )}
      {eta && !touch && (
        <span data-testid="file-browser-transfer-eta" style={muted}>
          {eta}
        </span>
      )}
      <button
        type="button"
        data-testid="file-browser-transfer-cancel"
        onClick={onCancel}
        className="odk-text-btn"
        aria-label="Cancel transfer"
        style={touch ? { minHeight: 44, padding: "0 12px" } : undefined}
      >
        [cancel]
      </button>
    </div>
  );
}

/** "An item named X already exists": Keep Both / Replace / Stop. */
export function FileConflictDialog({
  prompt,
  touch = false,
}: {
  prompt: ConflictPrompt;
  /** Phone: bottom-anchored card, full-width 44px buttons. */
  touch?: boolean;
}) {
  const [all, setAll] = useState(false);
  const keepRef = useRef<HTMLButtonElement | null>(null);
  const answer = (choice: ConflictChoice) => prompt.resolve({ choice, all });

  useEffect(() => {
    keepRef.current?.focus();
    // Capture phase: Escape stops the transfer without also closing the overlay.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      prompt.resolve({ choice: "stop", all: false });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [prompt]);

  const label = touch
    ? ({ textTransform: "lowercase", height: 44, flex: "1 1 30%" } as const)
    : ({ textTransform: "lowercase" } as const);
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="file-conflict-title"
      data-testid="file-conflict-dialog"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: colorAlpha.overlay,
        display: "flex",
        alignItems: touch ? "flex-end" : "center",
        justifyContent: "center",
        padding: touch ? "16px 16px max(16px, env(safe-area-inset-bottom))" : 16,
      }}
    >
      <div
        className="odk-float"
        style={{ minWidth: touch ? 0 : 280, maxWidth: 460, width: "100%", padding: 24, display: "flex", flexDirection: "column", gap: 12 }}
      >
        <div
          id="file-conflict-title"
          style={{ fontSize: rem(15), fontWeight: 600, color: colors.fg0, wordBreak: "break-word" }}
        >
          An item named “{prompt.name}” already exists in this location.
        </div>
        <div style={{ fontFamily: "var(--font-sans)", fontSize: rem(13), lineHeight: 1.5, color: colors.fg2 }}>
          Keep both to add a copy, or replace the existing item (it goes to the Trash).
        </div>
        {prompt.allowAll && (
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: rem(12.5), color: colors.fg2, cursor: "pointer" }}>
            <input
              type="checkbox"
              data-testid="file-conflict-apply-all"
              checked={all}
              onChange={(event) => setAll(event.target.checked)}
              style={{ accentColor: "rgb(var(--color-primary))" }}
            />
            apply to all
          </label>
        )}
        <div style={{ display: "flex", justifyContent: touch ? "stretch" : "flex-end", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
          <button type="button" data-testid="file-conflict-stop" onClick={() => answer("stop")} className="odk-btn odk-btn--secondary odk-btn--sm" style={label}>
            Stop
          </button>
          <button type="button" data-testid="file-conflict-replace" onClick={() => answer("replace")} className="odk-btn odk-btn--secondary odk-btn--sm" style={label}>
            Replace
          </button>
          <button ref={keepRef} type="button" data-testid="file-conflict-keep-both" onClick={() => answer("keep_both")} className="odk-btn odk-btn--primary odk-btn--sm" style={label}>
            Keep Both
          </button>
        </div>
      </div>
    </div>
  );
}
