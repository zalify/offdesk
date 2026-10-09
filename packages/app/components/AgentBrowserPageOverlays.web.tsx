import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { AgentBrowserDialog } from "@offdesk/shared";
import { dialogText } from "@/lib/agentBrowserOverlay";
import { colors, colorAlpha } from "@/lib/colors";

// What the desktop pane and the phone view draw over an agent browser's page:
// a loading bar, and the page's JavaScript dialogs, which headless Chromium
// does not paint.

/** A thin running bar along the top of the page while its main frame loads. */
export function AgentBrowserLoadingBar({ testId }: { testId: string }) {
  return (
    <div
      data-testid={testId}
      aria-hidden
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        height: 2,
        overflow: "hidden",
        zIndex: 2,
        pointerEvents: "none",
      }}
    >
      <span
        style={{
          display: "block",
          width: "38%",
          height: "100%",
          background: colors.accent,
          animation: "offdeskReconnect 1.1s ease-in-out infinite",
        }}
      />
    </div>
  );
}

/**
 * The page's alert, confirm, prompt or "Leave site?" dialog. It covers the
 * page, so nothing reaches it until the dialog is answered, as in a browser.
 * Only the device in control answers; everyone else sees it. Give it a `key`
 * per dialog so a typed prompt answer survives unrelated updates.
 */
export function AgentBrowserDialogOverlay({
  dialog,
  canAnswer,
  onAnswer,
  testId,
  compact = false,
}: {
  dialog: AgentBrowserDialog;
  canAnswer: boolean;
  onAnswer: (accept: boolean, promptText?: string) => void;
  testId: string;
  /** Phone sizes: bigger text and touch targets, nearly full width. */
  compact?: boolean;
}) {
  const text = dialogText(dialog);
  const [answer, setAnswer] = useState(dialog.default_prompt ?? "");
  const [sent, setSent] = useState(false);
  const firstRef = useRef<HTMLInputElement | null>(null);
  const acceptRef = useRef<HTMLButtonElement | null>(null);

  // Keys belong to the dialog now, not to the page behind it.
  useEffect(() => {
    if (!canAnswer) return;
    (firstRef.current ?? acceptRef.current)?.focus({ preventScroll: true });
  }, [canAnswer]);

  const answerWith = (accept: boolean) => {
    if (!canAnswer || sent) return;
    setSent(true);
    onAnswer(accept, accept && dialog.kind === "prompt" ? answer : undefined);
  };
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (!canAnswer) return;
    // Workspace shortcuts and the overlay's own Esc stay out of it.
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      answerWith(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      answerWith(text.dismiss === null);
    }
  };

  const fontSize = compact ? 14 : 12;
  const button = {
    fontSize,
    minHeight: compact ? 36 : 26,
    padding: compact ? "0 16px" : "0 12px",
    borderRadius: 6,
    cursor: canAnswer ? "pointer" : "default",
    opacity: canAnswer && !sent ? 1 : 0.5,
  } as const;

  return (
    <div
      data-testid={testId}
      data-kind={dialog.kind}
      role="presentation"
      onKeyDown={onKeyDown}
      onPointerDown={(event) => event.stopPropagation()}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 3,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: compact ? 24 : 48,
        background: colorAlpha.backgroundShadow,
      }}
    >
      <div
        role="alertdialog"
        aria-label={text.title}
        style={{
          width: compact ? "calc(100% - 32px)" : 420,
          maxWidth: "calc(100% - 32px)",
          boxSizing: "border-box",
          display: "flex",
          flexDirection: "column",
          gap: 10,
          padding: compact ? 16 : 14,
          borderRadius: 10,
          border: `1px solid ${colors.line}`,
          background: colors.bg1,
          color: colors.fg0,
          boxShadow: "0 12px 32px rgba(0, 0, 0, 0.35)",
        }}
      >
        <div style={{ fontSize, fontWeight: 600 }}>{text.title}</div>
        {text.message && (
          <div
            data-testid={`${testId}-message`}
            style={{
              fontSize,
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
              maxHeight: "40vh",
              overflowY: "auto",
            }}
          >
            {text.message}
          </div>
        )}
        {dialog.kind === "prompt" && (
          <input
            ref={firstRef}
            data-testid={`${testId}-input`}
            aria-label="Answer"
            value={answer}
            readOnly={!canAnswer}
            onChange={(event) => setAnswer(event.target.value)}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            style={{
              fontSize: compact ? 16 : 13,
              padding: "6px 8px",
              borderRadius: 6,
              border: `1px solid ${colors.border}`,
              background: colors.bg0,
              color: colors.foreground,
              outline: "none",
            }}
          />
        )}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 8,
          }}
        >
          {!canAnswer && (
            <span
              data-testid={`${testId}-hint`}
              style={{ flex: 1, fontSize: fontSize - 1, color: colors.foregroundMuted }}
            >
              Take over to answer
            </span>
          )}
          {text.dismiss !== null && (
            <button
              type="button"
              data-testid={`${testId}-dismiss`}
              disabled={!canAnswer || sent}
              onClick={() => answerWith(false)}
              style={{
                ...button,
                border: `1px solid ${colors.border}`,
                background: "transparent",
                color: colors.fg0,
              }}
            >
              {text.dismiss}
            </button>
          )}
          <button
            ref={acceptRef}
            type="button"
            data-testid={`${testId}-accept`}
            disabled={!canAnswer || sent}
            onClick={() => answerWith(true)}
            style={{
              ...button,
              border: "none",
              background: colors.accent,
              color: colors.onAccent,
            }}
          >
            {text.accept}
          </button>
        </div>
      </div>
    </div>
  );
}
