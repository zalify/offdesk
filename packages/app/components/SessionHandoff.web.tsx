import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type { TerminalInfo } from "@offdesk/shared";
import { ArrowRightLeft, X } from "lucide-react";
import { colors } from "@/lib/colors";
import { writeClipboardText } from "@/lib/writeClipboardText";
import { confirmSessionHandoff, listSessionHandoffs, saveSessionHandoff } from "@/lib/api";
import { agentLabel, formatHandoff, handoffTargets, newHandoffId, otherAgent,
  type HandoffAgent, type HandoffContent, type SessionHandoff } from "@/lib/sessionHandoff";

interface Props {
  terminal: TerminalInfo;
  terminals: TerminalInfo[];
  canWrite: boolean;
  deviceId: string;
  onPick: (id: string) => void;
  onCreate: (source: TerminalInfo, agent: HandoffAgent) => Promise<TerminalInfo | null>;
  openRequest?: number;
}

const button: CSSProperties = { border: `1px solid ${colors.border}`, borderRadius: 6,
  background: colors.surface, color: colors.foreground, padding: "8px 12px", cursor: "pointer", fontSize: 13 };
const input: CSSProperties = { width: "100%", boxSizing: "border-box", border: `1px solid ${colors.border}`,
  borderRadius: 6, background: colors.background, color: colors.foreground, padding: 9, font: "inherit" };
const label: CSSProperties = { display: "grid", gap: 6, fontSize: 13 };

export function SessionHandoffBar(props: Props) {
  const { terminal } = props;
  const [records, setRecords] = useState<SessionHandoff[]>([]);
  const [loadError, setLoadError] = useState("");
  const [loadedTerminal, setLoadedTerminal] = useState("");
  const [draftTarget, setDraftTarget] = useState<HandoffAgent | undefined>();
  const [view, setView] = useState<"draft" | SessionHandoff | null>(null);
  const lastOpenRequest = useRef(props.openRequest);
  useEffect(() => {
    if (props.openRequest !== lastOpenRequest.current) {
      lastOpenRequest.current = props.openRequest;
      setDraftTarget(undefined);
      setView("draft");
    }
  }, [props.openRequest]);
  const currentTerminal = useRef(terminal.id);
  currentTerminal.current = terminal.id;
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const items = await listSessionHandoffs(terminal.machine_id, terminal.id, signal);
      if (!signal?.aborted && currentTerminal.current === terminal.id) { setRecords(items); setLoadError(""); }
    } catch (error) {
      if (!signal?.aborted && currentTerminal.current === terminal.id) setLoadError(error instanceof Error ? error.message : "Could not load handoffs");
    } finally {
      if (!signal?.aborted && currentTerminal.current === terminal.id) setLoadedTerminal(terminal.id);
    }
  }, [terminal.id, terminal.machine_id]);
  useEffect(() => {
    const controller = new AbortController();
    setRecords([]); setView(null);
    void refresh(controller.signal);
    const focus = () => void refresh(controller.signal);
    window.addEventListener("focus", focus);
    return () => { controller.abort(); window.removeEventListener("focus", focus); };
  }, [refresh]);

  const pending = records.find(record => record.target_terminal_id === terminal.id && !record.submitted_at);
  const latest = records[0];
  const returnAgent = latest?.target_terminal_id === terminal.id ? latest.source_agent : undefined;
  const openDraft = (target: HandoffAgent) => { setDraftTarget(target); setView("draft"); };
  const changed = (record: SessionHandoff) => setRecords(previous =>
    [record, ...previous.filter(item => item.id !== record.id)].sort((a, b) => b.created_at - a.created_at));
  return <>
    <div className="session-handoff" data-testid="session-handoff-bar" style={{ display: "flex", alignItems: "center", gap: 8,
      flexWrap: "wrap", padding: "5px 10px", borderBottom: `1px solid ${colors.border}`, flexShrink: 0, fontSize: 12 }}>
      {(["codex", "claude"] as const).map(agent => <button key={agent} type="button"
        style={{ ...button, minHeight: 36, display: "flex", gap: 6, alignItems: "center",
          ...(returnAgent === agent ? { background: colors.accent, color: colors.onAccent } : {}) }}
        disabled={!props.canWrite || !terminal.reachable || loadedTerminal !== terminal.id}
        onClick={() => openDraft(agent)}>
        <ArrowRightLeft size={14} /> {returnAgent === agent ? "Hand back to" : "Hand off to"} {agentLabel(agent)}
      </button>)}
      {pending && <button type="button" style={{ ...button, padding: "5px 9px" }} onClick={() => setView(pending)}>Handoff ready to paste</button>}
      {records.length > 0 && <select aria-label="Handoff history" value="" style={{ ...input, width: "auto", maxWidth: 210, padding: 5 }}
        onChange={event => { const record = records.find(item => item.id === event.target.value); if (record) setView(record); }}>
        <option value="">Handoff history ({records.length})</option>
        {records.map(record => <option key={record.id} value={record.id}>
          {agentLabel(record.source_agent)} → {agentLabel(record.target_agent)} · {record.submitted_at ? "Submitted by you" : "Ready to paste"} · {new Date(record.created_at).toLocaleTimeString()}
        </option>)}
      </select>}
      {loadError && <button type="button" title={loadError} style={{ ...button, padding: "5px 9px" }} onClick={() => void refresh()}>Retry loading handoffs</button>}
    </div>
    {view && loadedTerminal === terminal.id && <HandoffDialog {...props} key={view === "draft" ? terminal.id : view.id}
      record={view === "draft" ? undefined : view} initialTarget={draftTarget}
      previous={draftTarget ? records.find(item =>
        (item.source_terminal_id === terminal.id ? item.source_agent : item.target_agent) === otherAgent(draftTarget)) : records[0]}
      onChanged={changed} onClose={() => setView(null)} />}
  </>;
}

function HandoffDialog({ terminal, terminals, canWrite, deviceId, onPick, onCreate, record, previous, initialTarget, onChanged, onClose }:
  Props & { initialTarget?: HandoffAgent; record?: SessionHandoff; previous?: SessionHandoff; onChanged: (record: SessionHandoff) => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const text = useRef<HTMLTextAreaElement>(null);
  const attempt = useRef<{ id: string; content: HandoffContent } | null>(null);
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saved, setSaved] = useState(record);
  const [sourceAgent, setSourceAgent] = useState<HandoffAgent>(() => initialTarget ? otherAgent(initialTarget) : previous
    ? previous.source_terminal_id === terminal.id ? previous.source_agent : previous.target_agent : "claude");
  const [created, setCreated] = useState<TerminalInfo | null>(null);
  const targets = handoffTargets(terminal, created && !terminals.some(t => t.id === created.id) ? [...terminals, created] : terminals);
  const priorTarget = previous ? previous.source_terminal_id === terminal.id ? previous.target_terminal_id : previous.source_terminal_id : "";
  const [targetId, setTargetId] = useState(targets.some(t => t.id === priorTarget) ? priorTarget : "");
  const [goal, setGoal] = useState(previous?.goal ?? "");
  const [intent, setIntent] = useState("");
  const [summary, setSummary] = useState("");
  const [artifacts, setArtifacts] = useState("");
  const [ready, setReady] = useState(false);
  const targetAgent = otherAgent(sourceAgent);
  const content: HandoffContent = { source_terminal_id: terminal.id, target_terminal_id: targetId,
    source_agent: sourceAgent, target_agent: targetAgent, cwd: terminal.cwd,
    goal: goal.trim(), intent: intent.trim(), summary: summary.trim(), artifacts: artifacts.trim() };
  const exceedsLimit = new TextEncoder().encode(content.goal + content.intent + content.summary + content.artifacts).length > 32_000;
  const canSave = canWrite && terminal.reachable && ready && content.goal && content.intent && content.summary &&
    targets.some(t => t.id === targetId) && !exceedsLimit;
  const packet = formatHandoff(saved ?? content);

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => { if (previousFocus?.isConnected) previousFocus.focus(); };
  }, []);

  const run = async (operation: () => Promise<void>) => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(""); setNotice("");
    try { await operation(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "The action could not be completed"); }
    finally { locked.current = false; setBusy(false); }
  };
  const save = () => {
    if (!canSave) return;
    void run(async () => {
      attempt.current ??= { id: newHandoffId(), content };
      const result = await saveSessionHandoff(terminal.machine_id, attempt.current.id, deviceId, attempt.current.content);
      setSaved(result); onChanged(result);
    });
  };
  const copy = (openTarget = false) => void run(async () => {
    try {
      await writeClipboardText(packet);
      if (openTarget && saved) openTerminal(saved.target_terminal_id);
      else setNotice("Copied. Paste into the target agent prompt when it is ready.");
    }
    catch { text.current?.focus(); text.current?.select(); throw new Error("Clipboard unavailable. Copy the selected instructions manually."); }
  });
  const openTerminal = (id: string) => { onClose(); onPick(id); };

  return <dialog className="session-handoff session-handoff-dialog" ref={dialog} aria-labelledby="session-handoff-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}
    style={{ width: "min(600px, calc(100vw - 24px))", maxHeight: "calc(100dvh - 32px)", boxSizing: "border-box", overflowY: "auto",
      border: `1px solid ${colors.border}`, borderRadius: 12, padding: 20, background: colors.surface, color: colors.foreground, boxShadow: "0 20px 70px #0008" }}>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
      <h2 id="session-handoff-title" style={{ fontSize: 18, margin: 0 }}>{saved ? `${agentLabel(saved.source_agent)} → ${agentLabel(saved.target_agent)}` : "Hand off this session"}</h2>
      <button type="button" aria-label="Close handoff" style={button} disabled={busy} onClick={onClose}><X size={16} /></button>
    </div>
    {saved ? <>
      <p role="status" style={{ fontSize: 13 }}>{saved.submitted_at ? "Submitted by you. Agent execution is not verified." : "Ready to paste. The instructions have been saved; they have not been sent to the agent."}</p>
      <label style={label}>Handoff instructions
        <textarea ref={text} readOnly value={packet} rows={12} style={{ ...input, resize: "vertical" }} />
      </label>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 16 }}>
        <button type="button" style={{ ...button, background: colors.accent, color: colors.onAccent }}
          disabled={busy || !terminals.some(t => t.id === saved.target_terminal_id && t.reachable)}
          onClick={() => copy(true)}>Copy & open {agentLabel(saved.target_agent)}</button>
        <button type="button" style={button} disabled={busy} onClick={() => copy()}>Copy instructions</button>
        <button type="button" style={button} disabled={busy || !terminals.some(t => t.id === saved.target_terminal_id && t.reachable)}
          onClick={() => openTerminal(saved.target_terminal_id)}>Open {agentLabel(saved.target_agent)} terminal</button>
        <button type="button" style={button} disabled={busy || !terminals.some(t => t.id === saved.source_terminal_id && t.reachable)}
          onClick={() => openTerminal(saved.source_terminal_id)}>View source terminal</button>
        {!saved.submitted_at && <button type="button" style={{ ...button, background: colors.accent, color: colors.onAccent }} disabled={busy || !canWrite}
          onClick={() => void run(async () => {
            const result = await confirmSessionHandoff(saved.machine_id, saved.id, deviceId);
            setSaved(result); onChanged(result);
          })}>I’ve submitted it to the agent</button>}
      </div>
      {!terminals.some(t => t.id === saved.target_terminal_id && t.reachable) && <p style={{ fontSize: 13 }}>The target terminal is unavailable. Your saved instructions are still here.</p>}
    </> : <>
      <p style={{ fontSize: 13, lineHeight: 1.5 }}>From <strong>{terminal.title || "Terminal"} · {terminal.id.slice(0, 8)}</strong>. Prepare instructions, then paste them into the other agent’s prompt. Both terminals use <strong style={{ overflowWrap: "anywhere" }}>{terminal.cwd}</strong>.</p>
      <fieldset disabled={busy || !canWrite || !!attempt.current} style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 14 }}>
        <label style={label}>Source agent
          <select value={sourceAgent} onChange={event => { setSourceAgent(event.target.value as HandoffAgent); setTargetId(""); setReady(false); }} style={input}>
            <option value="claude">Claude</option><option value="codex">Codex</option>
          </select>
        </label>
        <label style={label}>Target {agentLabel(targetAgent)} terminal
          <select aria-label="Target terminal" value={targetId} onChange={event => { setTargetId(event.target.value); setReady(false); }} style={input}>
            <option value="">Choose the terminal running {agentLabel(targetAgent)}</option>
            {targets.map(t => <option key={t.id} value={t.id}>{t.title || "Terminal"} · {t.id.slice(0, 8)}{t.id === priorTarget ? " · previously used" : ""}</option>)}
          </select>
        </label>
        <button type="button" style={{ ...button, justifySelf: "start" }} onClick={() => void run(async () => {
          const result = await onCreate(terminal, targetAgent);
          if (!result) throw new Error("Could not open a terminal. Check that you still have control.");
          setCreated(result); setTargetId(result.id); setReady(false);
          setNotice(`Opened a new ${agentLabel(targetAgent)} terminal. Complete its sign-in or setup before pasting.`);
        })}>Open new {agentLabel(targetAgent)} terminal</button>
        <label style={label}>Original goal<textarea value={goal} onChange={event => setGoal(event.target.value)} rows={2} maxLength={16000} style={input} /></label>
        <label style={label}>What should {agentLabel(targetAgent)} do next?<textarea aria-label="Next step" value={intent} onChange={event => setIntent(event.target.value)} rows={2} maxLength={16000} style={input} placeholder="Implement the API, or generate and save the images this page needs…" /></label>
        <label style={label}>Progress and context<textarea value={summary} onChange={event => setSummary(event.target.value)} rows={4} maxLength={24000} style={input} placeholder="Completed work, decisions, constraints, test results and remaining work" /></label>
        <label style={label}>Artifact paths (optional)<textarea value={artifacts} onChange={event => setArtifacts(event.target.value)} rows={2} maxLength={8000} style={input} placeholder="assets/hero.png — home page illustration" /></label>
        <p style={{ fontSize: 12, margin: 0, lineHeight: 1.5 }}>For images, include paths accessible to both agents. Image generation depends on the target agent’s tools; these paths are not uploaded or verified.</p>
        <label style={{ fontSize: 13, display: "flex", alignItems: "start", gap: 8 }}>
          <input type="checkbox" checked={ready} onChange={event => setReady(event.target.checked)} />
          The source agent has finished its work. I’ve chosen the correct target and will paste only into its agent prompt.
        </label>
      </fieldset>
      <details style={{ marginTop: 14, fontSize: 13 }}><summary>Preview instructions</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{packet}</pre></details>
      {exceedsLimit && <p role="alert">Keep the combined instructions under 32 KB.</p>}
      <p style={{ fontSize: 12 }}>The instructions you enter will be saved on this Hub for your other devices.</p>
      <button type="button" style={{ ...button, marginTop: 4, background: colors.accent, color: colors.onAccent }} disabled={busy || !canSave} onClick={save}>
        {busy ? "Working…" : attempt.current ? "Retry saving handoff" : `Prepare handoff to ${agentLabel(targetAgent)}`}
      </button>
    </>}
    {error && <p role="alert" style={{ fontSize: 13, overflowWrap: "anywhere" }}>{error}</p>}
    {notice && <p role="status" style={{ fontSize: 13 }}>{notice}</p>}
  </dialog>;
}
