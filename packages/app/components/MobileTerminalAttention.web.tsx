import { useEffect, useRef, useState } from "react";
import { sendAttentionEnter } from "@/lib/attentionEnter";
import { answerAgentRun } from "@/lib/api";
import { answerChoices, waitingRunsByTerminal } from "@/lib/agentRunRequests";
import type { AgentBrowserInfo, AgentRunInfo, MachineInfo, TerminalInfo } from "@offdesk/shared";
import { colors } from "@/lib/colors";
import { displayTerminalTitle } from "@/lib/displayTerminalTitle";
import { browserLabel } from "@/lib/agentBrowserOverlay";

const NO_BROWSERS: AgentBrowserInfo[] = [];
const NO_RUNS: AgentRunInfo[] = [];

export function MobileTerminalAttention({ terminals, machines, activeTerminalId, groupLabels, onPick, deviceId, canSend, browsers = NO_BROWSERS, activeBrowserId = null, onPickBrowser, runs = NO_RUNS }: {
  terminals: TerminalInfo[];
  machines: MachineInfo[];
  activeTerminalId: string | null;
  groupLabels: Map<string, string>;
  onPick: (id: string) => void;
  deviceId: string | null;
  canSend: (machineId: string) => boolean;
  /** Agent browsers of the active machine; a pending handoff asks for a person. */
  browsers?: AgentBrowserInfo[];
  activeBrowserId?: string | null;
  onPickBrowser?: (id: string) => void;
  /** Agent runs; one waiting on a person shows its question here, answerable in place. */
  runs?: AgentRunInfo[];
}) {
  const waitingRuns = waitingRunsByTerminal(runs);
  const pending = terminals.filter(t => t.id !== activeTerminalId && t.reachable
    && (t.attention === "confirmation" || waitingRuns.has(t.id))
    && machines.some(m => m.id === t.machine_id));
  const [answering, setAnswering] = useState<Set<string>>(() => new Set());
  // A browser the agent handed off, that this device is not already helping with.
  const handoffs = browsers.filter(b => b.handoff && b.id !== activeBrowserId
    && !(b.controller === "human" && b.controller_device_id === deviceId));
  const live = useRef({ pending, canSend, deviceId });
  live.current = { pending, canSend, deviceId };
  const requests = useRef(new Map<string, AbortController>());
  const [sent, setSent] = useState<Set<string>>(() => new Set());
  const [result, setResult] = useState<Record<string, "sent" | "check">>({});
  const [error, setError] = useState<string | null>(null);
  useEffect(() => () => {
    for (const controller of requests.current.values()) controller.abort();
    requests.current.clear();
  }, []);
  useEffect(() => {
    const ids = new Set(terminals.filter(t => t.reachable && t.attention === "confirmation").map(t => t.id));
    setSent(previous => [...previous].some(id => !ids.has(id))
      ? new Set([...previous].filter(id => ids.has(id))) : previous);
    setResult(previous => Object.keys(previous).some(id => !ids.has(id))
      ? Object.fromEntries(Object.entries(previous).filter(([id]) => ids.has(id))) : previous);
  }, [terminals]);
  const enter = async (terminal: TerminalInfo) => {
    if (sent.has(terminal.id) || requests.current.has(terminal.id) || !deviceId) return;
    const controller = new AbortController();
    requests.current.set(terminal.id, controller);
    setSent(previous => new Set(previous).add(terminal.id));
    setError(null);
    setResult(previous => { const next = { ...previous }; delete next[terminal.id]; return next; });
    try {
      await sendAttentionEnter({ machineId: terminal.machine_id, terminalId: terminal.id, deviceId,
        signal: controller.signal,
        isAllowed: () => live.current.deviceId === deviceId && live.current.canSend(terminal.machine_id)
          && live.current.pending.some(t => t.id === terminal.id && t.machine_id === terminal.machine_id),
      });
      if (!controller.signal.aborted) setResult(previous => ({ ...previous, [terminal.id]: "sent" }));
    } catch (reason) {
      if (!controller.signal.aborted) setResult(previous => ({ ...previous, [terminal.id]: "check" }));
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Open the terminal to check.");
    } finally { requests.current.delete(terminal.id); }
    // Keep disabled until the prompt clears, even after an uncertain delivery.
  };
  // An answer to the run's open request, typed into its terminal by the node. The
  // request stays until the agent moves on; the hub refuses a second answer.
  const answer = async (run: AgentRunInfo, choice: { approve?: boolean; option_id?: string }) => {
    if (!deviceId || !run.request || answering.has(run.request.id)) return;
    const requestId = run.request.id;
    setAnswering(previous => new Set(previous).add(requestId));
    setError(null);
    try {
      await answerAgentRun(run.id, { request_id: requestId, ...choice, device_id: deviceId });
    } catch (reason) {
      setAnswering(previous => { const next = new Set(previous); next.delete(requestId); return next; });
      const message = reason instanceof Error ? reason.message : "";
      setError(message.includes("control") ? "Take control of this machine to answer."
        : message.includes("Update Offdesk") ? "Update Offdesk on that machine to answer from here."
        : "Couldn't send the answer. Open the terminal to check.");
    }
  };
  const waiting = pending.length + handoffs.length;
  if (waiting === 0) return null;
  return (
    <nav aria-label="Sessions needing attention" data-testid="mobile-terminal-attention"
      style={{ flexShrink: 0, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: "6px 12px", borderBottom: `1px solid ${colors.lineSoft}`, background: colors.bg1, minWidth: 0, fontFamily: "var(--font-display)" }}>
      <span role="status" className="odk-badge" style={{ fontSize: 11.5 }}>
        {waiting} waiting
      </span>
      <div style={{ display: "flex", gap: 6, overflowX: "auto", minWidth: 0, flex: 1, overscrollBehaviorX: "contain" }}>
        {handoffs.map(browser => {
          const title = browserLabel(browser);
          const reason = browser.handoff?.reason ?? "";
          return (
            <button key={browser.id} type="button" data-testid={`mobile-attention-browser-${browser.id}`}
              aria-label={`Open browser ${title}, the agent needs you: ${reason}`}
              title={`${title} — the agent needs you: ${reason}`}
              onClick={() => onPickBrowser?.(browser.id)}
              style={{ ...chip, padding: "0 10px", color: colors.fg2 }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>browser · {title}</span>
              <span data-testid={`mobile-attention-browser-reason-${browser.id}`} style={{ overflow: "hidden", textOverflow: "ellipsis", color: colors.fg3, maxWidth: 120 }}>{reason}</span>
            </button>
          );
        })}
        {pending.map(terminal => {
          const title = displayTerminalTitle(terminal);
          const machine = machines.find(m => m.id === terminal.machine_id)?.name;
          const group = groupLabels.get(terminal.id) ?? terminal.cwd.split(/[\\/]/).filter(Boolean).pop();
          const context = [group, machine].filter(Boolean).join(" · ");
          const blocked = !deviceId || !canSend(terminal.machine_id) || sent.has(terminal.id);
          const run = waitingRuns.get(terminal.id);
          const prompt = run?.request?.prompt;
          const asking = run?.request?.kind === "question" ? "asks" : run?.request?.kind === "input" ? "needs input" : "confirmation requested";
          const choices = run ? answerChoices(run) : [];
          const answered = !!run?.request && (!!run.request.answer_sent_at_ms || answering.has(run.request.id));
          return (
            <div key={terminal.id} style={{ ...chip, padding: "0 3px 0 0" }}>
              <button type="button" data-testid={`mobile-attention-${terminal.id}`}
                aria-label={`Open ${title}, ${context}, ${asking}${prompt ? `: ${prompt}` : ""}`}
                title={`${title} · ${context} — ${asking}${prompt ? `: ${prompt}` : ""}`}
                onClick={() => onPick(terminal.id)}
                style={{ display: "flex", alignItems: "center", alignSelf: "stretch", maxWidth: 170, padding: "0 8px", border: 0, background: "transparent", color: colors.fg0, font: "inherit", fontSize: 12, fontWeight: 500, cursor: "pointer", whiteSpace: "nowrap" }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{title} · {group ?? machine}</span>
              </button>
              {prompt && (
                <span data-testid={`mobile-attention-prompt-${terminal.id}`} style={{ overflow: "hidden", textOverflow: "ellipsis", maxWidth: 160, color: colors.fg2, fontSize: 11.5 }}>{prompt}</span>
              )}
              {run && answered && (
                <span data-testid={`mobile-attention-sent-${terminal.id}`} style={{ padding: "0 8px", color: colors.fg3, fontSize: 11 }}>sent</span>
              )}
              {run && !answered && choices.map(choice => {
                const disabled = !deviceId || !canSend(terminal.machine_id);
                return (
                  <button key={choice.label} type="button" data-testid={`mobile-attention-answer-${terminal.id}-${choice.label}`}
                    aria-label={`Answer ${title}: ${choice.label}`}
                    disabled={disabled}
                    onPointerDown={event => event.preventDefault()}
                    onClick={() => void answer(run, choice.answer)}
                    className="odk-bracketed"
                    style={{ minWidth: 40, maxWidth: 110, height: 30, padding: "0 8px", border: 0, borderRadius: 3, background: disabled ? "transparent" : colors.primary, color: disabled ? colors.fg3 : colors.onPrimary, font: "inherit", fontSize: 11, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", cursor: "pointer", opacity: disabled ? 0.7 : 1 }}>
                    {choice.label}
                  </button>
                );
              })}
              {!run && <button type="button" data-testid={`mobile-attention-enter-${terminal.id}`}
                aria-label={`Send Enter to ${title}, ${context}`}
                title="Confirm the currently selected option in this terminal"
                disabled={blocked}
                onPointerDown={event => event.preventDefault()}
                onClick={() => void enter(terminal)}
                className="odk-bracketed"
                style={{ minWidth: 52, height: 30, padding: "0 8px", border: 0, borderRadius: 3, background: blocked ? "transparent" : colors.primary, color: blocked ? colors.fg3 : colors.onPrimary, font: "inherit", fontSize: 11, fontWeight: 600, textTransform: "lowercase", cursor: "pointer", opacity: blocked ? 0.7 : 1 }}>
                {sent.has(terminal.id) ? result[terminal.id] === "sent" ? "Sent" : result[terminal.id] === "check" ? "Check" : "…" : "Enter"}
              </button>}
            </div>
          );
        })}
      </div>
      {error && <span role="alert" style={{ flexBasis: "100%", color: colors.err, fontSize: 12 }}>{error}</span>}
    </nav>
  );
}

// A chip in the strip: 3px corners, the control edge.
const chip = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  flexShrink: 0,
  minHeight: 36,
  border: `1px solid ${colors.line}`,
  borderRadius: 3,
  background: "transparent",
  fontFamily: "inherit",
  fontSize: 12,
  whiteSpace: "nowrap",
  cursor: "pointer",
} as const;

/** The card over the active terminal while it waits on a confirmation
 *  (wireframe B-Phone): `[enter]` accepts the selected option — the same
 *  one-shot Enter as the strip — and `take control` when you are watching. */
export function MobileWaitingCard({ terminal, deviceId, canSend, isController, onTakeControl }: {
  terminal: TerminalInfo;
  deviceId: string | null;
  canSend: boolean;
  isController: boolean;
  onTakeControl: () => void;
}) {
  const [hidden, setHidden] = useState(false);
  const [state, setState] = useState<"idle" | "sending" | "sent" | "check">("idle");
  const [error, setError] = useState<string | null>(null);
  const live = useRef({ canSend, attention: terminal.attention });
  live.current = { canSend, attention: terminal.attention };
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => { setHidden(false); setState("idle"); setError(null); }, [terminal.id]);
  // Sit just above the key bar, which lives inside the terminal area.
  const cardRef = useRef<HTMLDivElement>(null);
  const [bottom, setBottom] = useState(12);
  useEffect(() => {
    const area = cardRef.current?.closest('[data-testid="mobile-terminal-area"]');
    const bar = area?.querySelector<HTMLElement>('[data-testid="extended-keybar"]');
    if (!area || !bar || typeof ResizeObserver === "undefined") return;
    const update = () => setBottom(Math.max(12, area.getBoundingClientRect().bottom - bar.getBoundingClientRect().top + 12));
    const observer = new ResizeObserver(update);
    observer.observe(bar);
    observer.observe(area);
    update();
    return () => observer.disconnect();
  }, [hidden, terminal.id]);
  if (hidden) return null;
  const title = displayTerminalTitle(terminal);
  const enter = async () => {
    if (state !== "idle" || !deviceId) return;
    const controller = new AbortController();
    request.current = controller;
    setState("sending");
    try {
      await sendAttentionEnter({
        machineId: terminal.machine_id, terminalId: terminal.id, deviceId, signal: controller.signal,
        isAllowed: () => live.current.canSend && live.current.attention === "confirmation",
      });
      if (!controller.signal.aborted) setState("sent");
    } catch (reason) {
      if (!controller.signal.aborted) {
        setState("check");
        setError(reason instanceof Error ? reason.message : "Open the terminal to check.");
      }
    }
  };
  return (
    <div ref={cardRef} data-testid="mobile-waiting-card" aria-live="polite"
      style={{ position: "absolute", left: 16, right: 16, bottom, zIndex: 6, display: "flex", flexDirection: "column", gap: 10, padding: 12,
        border: `1px solid ${colors.err}`, borderRadius: 4, background: colors.bg0, fontFamily: "var(--font-display)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 600, color: colors.err, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {title} is waiting for you
        </span>
        <button type="button" aria-label="Hide" onClick={() => setHidden(true)} className="odk-text-btn" style={{ minHeight: 28, minWidth: 28 }}>[x]</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: isController ? "1fr" : "repeat(2, minmax(0, 1fr))", gap: 8 }}>
        <button type="button" data-testid="mobile-waiting-enter" disabled={!deviceId || !canSend || state !== "idle"}
          onPointerDown={event => event.preventDefault()} onClick={() => void enter()}
          aria-label={`Send Enter to ${title}`} className="odk-btn odk-btn--secondary" style={{ height: 42 }}>
          {state === "sent" ? "sent" : state === "check" ? "check the terminal" : state === "sending" ? "…" : "[enter]"}
        </button>
        {!isController && (
          <button type="button" data-testid="mobile-waiting-take-control" onClick={onTakeControl} className="odk-btn odk-btn--primary" style={{ height: 42 }}>
            take control
          </button>
        )}
      </div>
      {error && <span role="alert" style={{ fontSize: 12, color: colors.err }}>{error}</span>}
    </div>
  );
}
