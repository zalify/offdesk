import { useEffect, useRef, useState } from "react";
import { colors, colorAlpha } from "@/lib/colors";
import { formatBytes } from "@/lib/resourceStats";
import { rem } from "@/lib/rem";
import "./Primitives.css";
import type { ConflictChoice, ConflictPrompt, TransferState } from "./useFileActions";

/** Slim progress strip above the status bar: current file, percent, cancel. */
export function FileTransferStrip({
  transfer,
  onCancel,
}: {
  transfer: TransferState;
  onCancel: () => void;
}) {
  const known = transfer.total > 0;
  const pct = known ? Math.min(100, Math.round((transfer.done / transfer.total) * 100)) : null;
  const verb = transfer.kind === "upload" ? "Uploading" : "Downloading";
  const queue = transfer.count > 1 ? ` (${transfer.index} of ${transfer.count})` : "";
  const detail =
    pct !== null
      ? `${pct}% · ${formatBytes(transfer.done)} of ${formatBytes(transfer.total)}`
      : transfer.kind === "download"
        ? "preparing…"
        : "";
  return (
    <div
      data-testid="file-browser-transfer"
      role="status"
      style={{
        flexShrink: 0,
        position: "relative",
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "6px 20px",
        borderTop: `1px solid ${colors.lineSoft}`,
        background: colors.bg1,
        fontSize: rem(12),
        color: colors.fg2,
        fontFamily: "var(--font-display)",
      }}
    >
      <span
        aria-hidden
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
        {verb} {transfer.name}
        {queue}
      </span>
      <span data-testid="file-browser-transfer-progress" style={{ flexShrink: 0, color: colors.fg3 }}>
        {detail}
      </span>
      <button
        type="button"
        data-testid="file-browser-transfer-cancel"
        onClick={onCancel}
        className="odk-text-btn"
        aria-label="Cancel transfer"
      >
        [cancel]
      </button>
    </div>
  );
}

/** "An item named X already exists": Keep Both / Replace / Stop. */
export function FileConflictDialog({
  prompt,
}: {
  prompt: ConflictPrompt;
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

  const label = { textTransform: "lowercase" } as const;
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
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        className="odk-float"
        style={{ minWidth: 280, maxWidth: 460, width: "100%", padding: 24, display: "flex", flexDirection: "column", gap: 12 }}
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
        <div style={{ display: "flex", justifyContent: "flex-end", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
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
