import { useEffect, useRef } from "react";
import { colors, colorAlpha } from "@/lib/colors";

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

  const confirmBg =
    variant === "danger" ? colors.danger : colors.accent;

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
          id="confirm-dialog-title"
          style={{
            fontSize: 15,
            fontWeight: 700,
            color: colors.foreground,
          }}
        >
          {title}
        </div>
        <div
          style={{
            fontSize: 13,
            lineHeight: 1.5,
            color: colors.foregroundSecondary,
            wordBreak: "break-word",
          }}
        >
          {message}
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: 4,
          }}
        >
          <button
            ref={cancelRef}
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
            {cancelLabel}
          </button>
          {secondaryLabel && onSecondary ? (
            <button
              type="button"
              onClick={onSecondary}
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
              {secondaryLabel}
            </button>
          ) : null}
          <button
            type="button"
            onClick={onConfirm}
            style={{
              background: confirmBg,
              border: "none",
              borderRadius: 6,
              color: colors.onAccent,
              cursor: "pointer",
              fontSize: 13,
              fontWeight: 700,
              padding: "6px 14px",
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
