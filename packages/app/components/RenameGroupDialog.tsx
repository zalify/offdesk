import { useEffect, useRef, useState } from "react";
import { colors, colorAlpha } from "@/lib/colors";

interface RenameGroupDialogProps {
  open: boolean;
  initialName: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}

export function RenameGroupDialog({
  open,
  initialName,
  onSubmit,
  onCancel,
}: RenameGroupDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(initialName);

  const trimmed = name.trim();
  const canSubmit = trimmed.length > 0;

  useEffect(() => {
    if (!open) return;
    setName(initialName);
    // Focus the input and select the current name so typing replaces it.
    inputRef.current?.focus();
    inputRef.current?.select();

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, initialName, onCancel]);

  if (!open) return null;

  const submit = () => {
    if (!canSubmit) return;
    onSubmit(trimmed);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="rename-group-dialog-title"
      onClick={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: colorAlpha.backgroundShadow,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: colors.surface,
          border: `1px solid ${colors.border}`,
          borderRadius: 10,
          minWidth: 280,
          maxWidth: 420,
          width: "100%",
          padding: 20,
          boxShadow: "0 20px 60px rgba(0, 0, 0, 0.4)",
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <div
          id="rename-group-dialog-title"
          style={{
            fontSize: 15,
            fontWeight: 700,
            color: colors.foreground,
          }}
        >
            Rename tab
        </div>
        <input
          ref={inputRef}
          type="text"
          value={name}
          aria-label="Tab name"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          style={{
            background: colors.background,
            border: `1px solid ${colors.border}`,
            borderRadius: 6,
            color: colors.foreground,
            fontSize: 13,
            padding: "6px 10px",
            outline: "none",
            width: "100%",
            boxSizing: "border-box",
          }}
        />
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: 4,
          }}
        >
          <button
            type="button"
            onClick={onCancel}
            style={{
              background: "transparent",
              border: `1px solid ${colors.border}`,
              borderRadius: 6,
              color: colors.foreground,
              cursor: "pointer",
              fontSize: 13,
              fontWeight: 500,
              padding: "6px 14px",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={submit}
            style={{
              background: colors.accent,
              border: "none",
              borderRadius: 6,
              color: colors.onAccent,
              cursor: canSubmit ? "pointer" : "not-allowed",
              opacity: canSubmit ? 1 : 0.45,
              fontSize: 13,
              fontWeight: 700,
              padding: "6px 14px",
            }}
          >
            Rename
          </button>
        </div>
      </div>
    </div>
  );
}
