import { useEffect, useRef } from "react";
import { colors, colorAlpha } from "@/lib/colors";
import "./Primitives.css";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "default" | "danger";
  // A second, non-destructive way out, drawn between Cancel and the
  // confirm: "Ungroup" next to "Close 2 terminals".
  secondaryLabel?: string;
  onSecondary?: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  variant = "default",
  secondaryLabel,
  onSecondary,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    // Focus cancel by default — safer than focusing destructive confirm.
    cancelRef.current?.focus();

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        onConfirm();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onCancel, onConfirm]);

  if (!open) return null;

  // Chrome is lowercase; callers pass sentence-case labels ("Close
  // terminal"), so the buttons lowercase them for display only.
  const label = { textTransform: "lowercase" } as const;

  return (
    <div
      role="dialog"
      aria-modal="true"
      data-testid="confirm-dialog"
      aria-labelledby="confirm-dialog-title"
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
          maxWidth: 460,
          width: "100%",
          padding: 24,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <div
          id="confirm-dialog-title"
          style={{
            fontSize: 17,
            fontWeight: 600,
            letterSpacing: "-0.02em",
            color: colors.fg0,
          }}
        >
          {title}
        </div>
        <div
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: 14,
            lineHeight: 1.55,
            color: colors.fg2,
            wordBreak: "break-word",
          }}
        >
          {message}
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            flexWrap: "wrap",
            gap: 8,
            marginTop: 8,
          }}
        >
          <button ref={cancelRef} type="button" onClick={onCancel} className="odk-btn odk-btn--secondary odk-btn--sm" style={label}>
            {cancelLabel}
          </button>
          {secondaryLabel && onSecondary ? (
            <button type="button" onClick={onSecondary} className="odk-btn odk-btn--secondary odk-btn--sm" style={label}>
              {secondaryLabel}
            </button>
          ) : null}
          <button
            type="button"
            onClick={onConfirm}
            className={`odk-btn odk-btn--sm ${variant === "danger" ? "odk-btn--danger" : "odk-btn--primary"}`}
            style={variant === "danger" ? { ...label, borderColor: colors.err } : label}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
