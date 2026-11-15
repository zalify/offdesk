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

  // The parent passes a new onCancel on every render, and it re-renders while
  // the dialog is open (terminal output, presence). Keep the latest callback in
  // a ref so those renders don't re-run the effects below.
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  const initialNameRef = useRef(initialName);
  initialNameRef.current = initialName;

  // Only when the dialog opens: start from the current name, focused and
  // selected so typing replaces it. Running this again later would throw away
  // what the user has typed.
  useEffect(() => {
    if (!open) return;
    setName(initialNameRef.current);
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancelRef.current();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open]);

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
