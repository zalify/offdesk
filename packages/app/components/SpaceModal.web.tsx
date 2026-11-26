import { useEffect, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import type { CreateSpaceRequest, SpaceInfo, UpdateSpaceRequest } from "@offdesk/shared";

import { colors, colorAlpha } from "@/lib/colors";
import { rem } from "@/lib/rem";
import {
  DEFAULT_SPACE_COLOR,
  SPACE_COLOR_PRESETS,
  SPACE_ICON_PRESETS,
} from "@/lib/spaces";
import "./Primitives.css";

interface SpaceModalProps {
  open: boolean;
  space: SpaceInfo | null;
  onCreate: (payload: CreateSpaceRequest) => Promise<void>;
  onUpdate: (spaceId: string, patch: UpdateSpaceRequest) => Promise<void>;
  onDelete: (spaceId: string) => Promise<void>;
  onClose: () => void;
}

export function SpaceModal({
  open,
  space,
  onCreate,
  onUpdate,
  onDelete,
  onClose,
}: SpaceModalProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(DEFAULT_SPACE_COLOR);
  const [icon, setIcon] = useState<string>("");
  const [defaultCwd, setDefaultCwd] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    if (!open) return;
    setName(space?.name ?? "");
    setColor(space?.color ?? DEFAULT_SPACE_COLOR);
    setIcon(space?.icon ?? "");
    setDefaultCwd(space?.default_cwd ?? "");
    setBusy(false);
    setConfirmDelete(false);
    setError(null);
    window.setTimeout(() => {
      inputRef.current?.focus();
      if (space) inputRef.current?.select();
    }, 0);
  }, [open, space]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busyRef.current) {
        e.preventDefault();
        onCloseRef.current();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open]);

  if (!open) return null;

  const trimmedName = name.trim();
  const canSubmit = trimmedName.length > 0 && !busy;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const normalizedCwd = defaultCwd.trim() || null;
      const normalizedIcon = icon.trim() || null;
      const normalizedColor = color || null;
      if (space) {
        await onUpdate(space.id, {
          name: trimmedName,
          color: normalizedColor,
          icon: normalizedIcon,
          default_cwd: normalizedCwd,
        });
      } else {
        await onCreate({
          name: trimmedName,
          color: normalizedColor,
          icon: normalizedIcon,
          default_cwd: normalizedCwd,
        });
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!space || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onDelete(space.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="space-modal-title"
      data-testid="space-modal"
      onClick={() => {
        if (!busy) onClose();
      }}
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
        onClick={(e) => e.stopPropagation()}
        className="odk-float"
        style={{
          minWidth: 300,
          maxWidth: 440,
          width: "100%",
          padding: 24,
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <div
          id="space-modal-title"
          style={{
            fontSize: rem(17),
            fontWeight: 600,
            letterSpacing: "-0.02em",
            color: colors.fg0,
          }}
        >
          {space ? "Edit Space" : "New Space"}
        </div>

        <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontSize: rem(12), fontWeight: 500, color: colors.fg2 }}>
            Name
          </span>
          <input
            ref={inputRef}
            type="text"
            data-testid="space-modal-name"
            value={name}
            placeholder="e.g. Work, Personal, Client A"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleSubmit();
              }
            }}
            className="odk-input"
          />
        </label>

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontSize: rem(12), fontWeight: 500, color: colors.fg2 }}>
            Accent color
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {SPACE_COLOR_PRESETS.map((preset) => {
              const selected = color === preset;
              return (
                <button
                  key={preset}
                  type="button"
                  aria-label={`Color ${preset}`}
                  aria-pressed={selected}
                  onClick={() => setColor(preset)}
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: 999,
                    border: selected ? `2px solid ${colors.fg0}` : "2px solid transparent",
                    padding: 2,
                    background: "transparent",
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <span
                    style={{
                      width: 16,
                      height: 16,
                      borderRadius: 999,
                      background: preset,
                      display: "block",
                    }}
                  />
                </button>
              );
            })}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontSize: rem(12), fontWeight: 500, color: colors.fg2 }}>
            Icon (optional)
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            {SPACE_ICON_PRESETS.map((preset) => {
              const selected = icon === preset;
              return (
                <button
                  key={preset || "none"}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setIcon(preset)}
                  style={{
                    minWidth: 30,
                    height: 28,
                    padding: "0 7px",
                    borderRadius: 6,
                    border: `1px solid ${selected ? colors.accent : colors.line}`,
                    background: selected ? colorAlpha.accentSoft : colors.bg2,
                    color: selected ? colors.fg0 : colors.fg2,
                    fontSize: preset ? rem(14) : rem(11),
                    cursor: "pointer",
                  }}
                >
                  {preset || "None"}
                </button>
              );
            })}
          </div>
        </div>

        <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontSize: rem(12), fontWeight: 500, color: colors.fg2 }}>
            Default directory (optional)
          </span>
          <input
            type="text"
            data-testid="space-modal-cwd"
            value={defaultCwd}
            placeholder="e.g. ~/projects/app"
            onChange={(e) => setDefaultCwd(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleSubmit();
              }
            }}
            className="odk-input"
            style={{ fontFamily: "var(--font-mono)" }}
          />
          <span style={{ fontSize: rem(11), color: colors.fg3 }}>
            New terminals opened while this Space is active start here.
          </span>
        </label>

        {error && (
          <div role="alert" style={{ fontSize: rem(12), color: colors.err }}>
            {error}
          </div>
        )}

        {space && confirmDelete ? (
          <div
            data-testid="space-modal-delete-confirm"
            style={{
              padding: 12,
              borderRadius: 8,
              border: `1px solid ${colors.err}`,
              background: "rgb(var(--color-err) / 0.08)",
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            <div style={{ fontSize: rem(12.5), color: colors.fg0, lineHeight: 1.45 }}>
              Delete space <strong>{space.name}</strong>? Your terminals and drafts stay
              safe — they will simply become unassigned.
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirmDelete(false)}
                className="odk-btn odk-btn--secondary"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="space-modal-delete-confirm-btn"
                disabled={busy}
                onClick={() => void handleDelete()}
                className="odk-btn odk-btn--danger"
              >
                {busy ? "Deleting…" : "Delete space"}
              </button>
            </div>
          </div>
        ) : (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              marginTop: 4,
            }}
          >
            {space ? (
              <button
                type="button"
                data-testid="space-modal-delete"
                disabled={busy}
                onClick={() => setConfirmDelete(true)}
                className="odk-btn odk-btn--secondary"
                style={{
                  color: colors.err,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                }}
              >
                <Trash2 size={13} aria-hidden />
                Delete
              </button>
            ) : (
              <span />
            )}
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                disabled={busy}
                onClick={onClose}
                className="odk-btn odk-btn--secondary"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="space-modal-submit"
                disabled={!canSubmit}
                onClick={() => void handleSubmit()}
                className="odk-btn odk-btn--primary"
              >
                {busy ? "Saving…" : space ? "Save" : "Create"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
