import { useEffect, useRef, useState } from "react";
import { colors, colorAlpha } from "@/lib/colors";
import "./Primitives.css";
import { rem } from "@/lib/rem";

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
          minWidth: 280,
          maxWidth: 420,
          width: "100%",
          padding: 24,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <div
          id="rename-group-dialog-title"
          style={{
            fontSize: rem(17),
            fontWeight: 600,
            letterSpacing: "-0.02em",
            color: colors.fg0,
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
          className="odk-input"
        />
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: 4,
          }}
        >
          <button type="button" onClick={onCancel} aria-label="Cancel" className="odk-btn odk-btn--secondary odk-btn--sm">
            cancel
          </button>
          <button type="button" disabled={!canSubmit} onClick={submit} aria-label="Rename" className="odk-btn odk-btn--primary odk-btn--sm">
            rename
          </button>
        </div>
      </div>
    </div>
  );
}
