import { createContext, useContext, useEffect, useRef, useState, type CSSProperties } from "react";
import type { RelayAgent, RelayBrief, TerminalInfo } from "@offdesk/shared";
import { getRelayBrief } from "@/lib/api";
import {
  agentLabel,
  composeRelayBrief,
  finalRelayPrompt,
  newRelayId,
  otherAgent,
  relayPromptProblem,
} from "@/lib/agentRelay";
import { colors, colorAlpha } from "@/lib/colors";

/** Provided by TerminalWorkspace; panes read it to offer relays. */
export interface AgentRelayContextValue {
  terminalsById: Map<string, TerminalInfo>;
  /** The viewer holds control and can type; relays create terminals. */
  canWrite: boolean;
  onPick: (terminalId: string) => void;
  onRelay: (
    source: TerminalInfo,
    target: RelayAgent,
    prompt: string,
    relayId: string,
  ) => Promise<TerminalInfo>;
  /** Bumped by the pane context menu to open a relay for one terminal. */
  relayRequest: { terminalId: string; nonce: number } | null;
}

export const AgentRelayContext = createContext<AgentRelayContextValue | null>(null);

const chip: CSSProperties = {
  pointerEvents: "auto",
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  minHeight: 30,
  padding: "4px 10px",
  borderRadius: 999,
  border: `1px solid ${colors.border}`,
  background: "rgba(20, 20, 24, 0.88)",
  color: colors.foreground,
  font: "600 12px system-ui, sans-serif",
  cursor: "pointer",
};

const primaryButton: CSSProperties = {
  minHeight: 44,
  padding: "0 14px",
  border: 0,
  borderRadius: 8,
  background: colors.accent,
  color: colors.onAccent,
  font: "600 14px system-ui, sans-serif",
  cursor: "pointer",
};

const secondaryButton: CSSProperties = {
  ...primaryButton,
  background: "transparent",
  color: colors.foreground,
  border: `1px solid ${colors.border}`,
  fontWeight: 500,
};

/**
 * Floats over a terminal running Claude or Codex: the agent chip and its
 * menu, a link back to the terminal a relay came from, and the usage-limit
 * card. Overlays never resize the terminal.
 */
export function AgentRelayOverlay({ terminal, topInset }: { terminal: TerminalInfo; topInset: number }) {
  const relay = useContext(AgentRelayContext);
  const [menuOpen, setMenuOpen] = useState(false);
  const [sheetTarget, setSheetTarget] = useState<RelayAgent | null>(null);
  const [dismissedLimit, setDismissedLimit] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const agent = terminal.agent ?? null;

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      setMenuOpen(false);
    };
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("keydown", close, true);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("keydown", close, true);
    };
  }, [menuOpen]);

  const request = relay?.relayRequest;
  useEffect(() => {
    if (request?.terminalId === terminal.id && agent) setSheetTarget(otherAgent(agent.kind));
    // Only a new request opens the sheet, not a later agent change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.nonce]);

  if (!relay) return null;
  const source = terminal.relay_source ?? null;
  const sourceTerminal = source ? relay.terminalsById.get(source.terminal_id) : undefined;
  const limit = agent?.usage_limit && agent.usage_limit !== dismissedLimit ? agent.usage_limit : null;
  if (!agent && !sourceTerminal) return null;
  const target = agent ? otherAgent(agent.kind) : null;

  return (
    <>
      <div
        style={{
          position: "absolute",
          top: 8 + topInset,
          right: 10,
          display: "flex",
          gap: 6,
          alignItems: "flex-start",
          pointerEvents: "none",
        }}
      >
        {source && sourceTerminal && (
          <button
            type="button"
            data-testid="relay-back"
            style={chip}
            onClick={() => relay.onPick(source.terminal_id)}
            title={`Back to the ${agentLabel(source.agent)} terminal this task came from`}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9 14L4 9l5-5" />
              <path d="M4 9h10a6 6 0 0 1 6 6v5" />
            </svg>
            From {agentLabel(source.agent)}
          </button>
        )}
        {agent && target && (
          <div ref={menuRef} style={{ position: "relative", pointerEvents: "auto" }}>
            <button
              type="button"
              data-testid="agent-chip"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              style={chip}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <span style={{ width: 7, height: 7, borderRadius: 4, background: limit ? colors.warning : colors.accent }} />
              {agentLabel(agent.kind)}
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
            {menuOpen && (
              <div
                role="menu"
                data-testid="agent-menu"
                style={{
                  position: "absolute",
                  top: "calc(100% + 6px)",
                  right: 0,
                  width: 260,
                  zIndex: 30,
                  padding: 6,
                  borderRadius: 10,
                  border: `1px solid ${colors.border}`,
                  background: colors.surface,
                  boxShadow: `0 8px 24px ${colorAlpha.backgroundShadow}`,
                }}
              >
                <button
                  type="button"
                  role="menuitem"
                  disabled={!relay.canWrite}
                  onClick={() => {
                    setMenuOpen(false);
                    setSheetTarget(target);
                  }}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 2,
                    width: "100%",
                    minHeight: 44,
                    padding: "8px 10px",
                    border: 0,
                    borderRadius: 6,
                    background: "transparent",
                    color: colors.foreground,
                    textAlign: "left",
                    cursor: relay.canWrite ? "pointer" : "not-allowed",
                    opacity: relay.canWrite ? 1 : 0.55,
                  }}
                >
                  <span style={{ fontSize: 14, fontWeight: 600 }}>Continue in {agentLabel(target)}</span>
                  <span style={{ fontSize: 12, color: colors.foregroundSecondary }}>
                    {relay.canWrite
                      ? `${agentLabel(target)} picks up where ${agentLabel(agent.kind)} left off.`
                      : "Take control of this machine first."}
                  </span>
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {agent && target && limit && (
        <section
          aria-label="Usage limit"
          data-testid="usage-limit-card"
          style={{
            position: "absolute",
            left: 10,
            right: 10,
            bottom: 10,
            pointerEvents: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 10,
            padding: 12,
            borderRadius: 12,
            border: `1px solid ${colorAlpha.warningBorder}`,
            background: colors.surface,
            color: colors.foreground,
            boxShadow: `0 8px 24px ${colorAlpha.backgroundShadow}`,
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={{ fontSize: 15, fontWeight: 600 }}>{agentLabel(agent.kind)} hit its usage limit</span>
            <span style={{ fontSize: 13, color: colors.foregroundSecondary }}>{limit}</span>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              disabled={!relay.canWrite}
              style={{ ...primaryButton, flex: 2, opacity: relay.canWrite ? 1 : 0.55 }}
              onClick={() => setSheetTarget(target)}
            >
              Continue in {agentLabel(target)}
            </button>
            <button type="button" style={{ ...secondaryButton, flex: 1 }} onClick={() => setDismissedLimit(limit)}>
              Wait
            </button>
          </div>
          {!relay.canWrite && (
            <span style={{ fontSize: 12, color: colors.foregroundSecondary }}>
              Take control of this machine to continue in {agentLabel(target)}.
            </span>
          )}
        </section>
      )}

      {sheetTarget && agent && (
        <RelaySheet
          source={terminal}
          sourceAgent={agent.kind}
          target={sheetTarget}
          onRelay={relay.onRelay}
          onClose={() => setSheetTarget(null)}
        />
      )}
    </>
  );
}

function RelaySheet({
  source,
  sourceAgent,
  target,
  onRelay,
  onClose,
}: {
  source: TerminalInfo;
  sourceAgent: RelayAgent;
  target: RelayAgent;
  onRelay: AgentRelayContextValue["onRelay"];
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  // One id per sheet: a retry after a lost response returns the same terminal.
  const relayId = useRef(newRelayId()).current;
  const [brief, setBrief] = useState<RelayBrief | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    getRelayBrief(source.machine_id, source.id, controller.signal)
      .then((result) => {
        setBrief(result);
        setBody(composeRelayBrief(result));
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(reason instanceof Error ? reason.message.replace(/^\d+: /, "") : "Could not read the session.");
        setBody(composeRelayBrief({ agent: sourceAgent, cwd: source.cwd, tasks: [], warnings: [] }));
      });
    return () => controller.abort();
  }, [source.cwd, source.id, source.machine_id, sourceAgent]);

  const loading = !brief && !loadError;
  const prompt = finalRelayPrompt(body, note);
  const problem = loading ? null : relayPromptProblem(prompt);

  const start = async () => {
    if (busy || loading || problem) return;
    setBusy(true);
    setError(null);
    try {
      await onRelay(source, target, prompt, relayId);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message.replace(/^\d+: /, "") : "Could not start the relay.");
      setBusy(false);
    }
  };

  const sourceLabel = agentLabel(sourceAgent);
  const targetLabel = agentLabel(target);
  const provenance = brief
    ? brief.session_id
      ? `Built from ${sourceLabel}'s session${brief.git ? " and git changes" : ""}`
      : `${sourceLabel}'s session could not be matched; only git changes are included`
    : null;

  return (
    <dialog
      ref={dialogRef}
      className="agent-relay-dialog"
      data-testid="relay-sheet"
      aria-labelledby="relay-sheet-title"
      onClose={onClose}
      onCancel={(event) => {
        if (busy) event.preventDefault();
      }}
      style={{
        width: "min(560px, calc(100vw - 24px))",
        maxHeight: "min(90dvh, 900px)",
        padding: 0,
        border: `1px solid ${colors.border}`,
        borderRadius: 14,
        background: colors.surface,
        color: colors.foreground,
      }}
    >
      <form
        method="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          void start();
        }}
        style={{ display: "flex", flexDirection: "column", maxHeight: "inherit" }}
      >
        <div style={{ padding: "14px 16px 10px", borderBottom: `1px solid ${colors.border}` }}>
          <h2 id="relay-sheet-title" style={{ margin: 0, fontSize: 17 }}>
            Continue in {targetLabel}
          </h2>
          <div style={{ marginTop: 2, fontSize: 12, color: colors.foregroundSecondary }}>
            From {sourceLabel} · {source.title || source.cwd}
          </div>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
          {loading && <div role="status">Reading {sourceLabel}'s session…</div>}
          {provenance && (
            <span
              data-testid="relay-provenance"
              style={{ alignSelf: "flex-start", fontSize: 12, padding: "3px 8px", borderRadius: 999, border: `1px dashed ${colors.border}` }}
            >
              {provenance}
            </span>
          )}
          {loadError && (
            <div role="alert" style={{ fontSize: 13, color: colors.warning }}>
              Couldn't read the session: {loadError} You can still continue with your own note.
            </div>
          )}
          {brief?.warnings.map((warning) => (
            <div key={warning} style={{ fontSize: 12, color: colors.foregroundSecondary }}>
              {warning}
            </div>
          ))}
          {!loading && (
            <>
              <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12, color: colors.foregroundSecondary }}>
                Handoff brief (sent as {targetLabel}'s first message)
                <textarea
                  data-testid="relay-brief"
                  value={body}
                  readOnly={busy}
                  onChange={(event) => setBody(event.target.value)}
                  rows={12}
                  style={{
                    resize: "vertical",
                    padding: 10,
                    borderRadius: 8,
                    border: `1px solid ${colors.border}`,
                    background: colors.background,
                    color: colors.foreground,
                    font: "13px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace",
                  }}
                />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12, color: colors.foregroundSecondary }}>
                Anything to add?
                <input
                  data-testid="relay-note"
                  value={note}
                  readOnly={busy}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="e.g. Don't touch the Web Pixel code"
                  style={{
                    minHeight: 44,
                    padding: "0 10px",
                    borderRadius: 8,
                    border: `1px solid ${colors.border}`,
                    background: colors.background,
                    color: colors.foreground,
                    fontSize: 16,
                  }}
                />
              </label>
            </>
          )}
          {(error || problem) && (
            <div role="alert" style={{ fontSize: 13, color: colors.danger }}>
              {error ?? problem}
            </div>
          )}
        </div>

        <div style={{ padding: "12px 16px 16px", borderTop: `1px solid ${colors.border}`, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" style={{ ...secondaryButton, flex: 1 }} disabled={busy} onClick={() => dialogRef.current?.close()}>
              Cancel
            </button>
            <button
              type="submit"
              data-testid="relay-start"
              style={{ ...primaryButton, flex: 2, opacity: busy || loading || problem ? 0.6 : 1 }}
              disabled={busy || loading || Boolean(problem)}
            >
              {busy ? `Starting ${targetLabel}…` : `Start ${targetLabel}`}
            </button>
          </div>
          <span style={{ fontSize: 12, color: colors.foregroundSecondary, textAlign: "center" }}>
            {targetLabel} starts in a new tab in the same folder. {sourceLabel}'s session stays as it is.
          </span>
        </div>
      </form>
    </dialog>
  );
}
