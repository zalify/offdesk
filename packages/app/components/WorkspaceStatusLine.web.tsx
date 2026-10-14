// The desktop workspace's bottom line, tmux-style. Left: the terminal that is
// waiting on you (a confirmation prompt), with [enter] to accept the selected
// option and "open" to go to it; workspace messages (a refused split, a
// saved download) take this slot for a few seconds. Right: machine, how many
// are connected, round trip, the ⌃B prefix when armed, and who has the
// keyboard — "in control" on lime, or "take control" while watching. When
// the desktop app has an update, `↑ update 0.9.1` sits before the machine and
// opens the update card.

import { useEffect, useRef, useState } from "react";
import type { MachineInfo, TerminalInfo } from "@offdesk/shared";

import { sendAttentionEnter } from "@/lib/attentionEnter";
import { displayTerminalTitle } from "@/lib/displayTerminalTitle";
import { collectPaneTerminalIds, type WorkspaceGroup } from "@/lib/terminalWorkspaceLayout";
import { subscribeWorkspaceMessages, type WorkspaceMessage } from "@/lib/workspaceToast";
import { subscribePaneSizeNotice, type PaneSizeNotice } from "@/lib/paneSizeNotice";
import { openUpdateCard, useDesktopUpdate } from "@/lib/desktopUpdate";
import { StatusBadge, StatusEnd, StatusLine } from "./Primitives.web";

export function WorkspaceStatusLine({
  terminals,
  machines,
  activeMachine,
  machineOnline,
  groups,
  rttMs,
  isController,
  viewOnlyLocked,
  prefixArmed,
  deviceId,
  canSend,
  onOpenTerminal,
  onRequestControl,
  onEngageViewOnly,
  onDisengageViewOnly,
  browserWaiting = null,
}: {
  terminals: TerminalInfo[];
  machines: MachineInfo[];
  activeMachine: MachineInfo | null;
  machineOnline: Record<string, boolean>;
  /** The active machine's tabs, to name a waiting terminal "1:api". */
  groups: WorkspaceGroup[];
  rttMs: number | null;
  isController: boolean;
  viewOnlyLocked: boolean;
  prefixArmed: boolean;
  deviceId: string | null;
  canSend: (machineId: string) => boolean;
  onOpenTerminal: (terminal: TerminalInfo) => void;
  onRequestControl: () => void;
  onEngageViewOnly: () => void;
  onDisengageViewOnly: () => void;
  /** An agent browser tab that handed off to a person. */
  browserWaiting?: { label: string; reason: string; open: () => void } | null;
}) {
  const message = useWorkspaceMessage();
  const update = useDesktopUpdate();
  const sizeNotice = usePaneSizeNotice();
  const waiting = terminals.filter(
    (t) => t.reachable && t.attention === "confirmation" && machines.some((m) => m.id === t.machine_id),
  );
  const first = waiting[0] ?? null;
  const enter = useAttentionEnter(waiting, deviceId, canSend);

  const name = (terminal: TerminalInfo) => {
    const title = displayTerminalTitle(terminal);
    if (terminal.machine_id !== activeMachine?.id) {
      const machine = machines.find((m) => m.id === terminal.machine_id)?.name;
      return machine ? `${machine} ${title}` : title;
    }
    const index = groups.findIndex((g) => collectPaneTerminalIds(g.root).includes(terminal.id));
    return index >= 0 ? `${index}:${groups[index].label} ${title}` : title;
  };

  const online = machines.filter((m) => machineOnline[m.id]).length;
  const where = [
    activeMachine?.name,
    machines.length > 1 ? `${online} machine${online === 1 ? "" : "s"}` : null,
    rttMs === null ? "—" : `${Math.round(rttMs)}ms`,
  ].filter(Boolean);

  return (
    <StatusLine testId="workspace-status-line">
      {message ? (
        <span
          data-testid={message.kind === "notice" ? "offdesk-notice" : "workspace-toast"}
          aria-live="polite"
          className="odk-status-text"
          style={message.tone === "error" ? { color: "rgb(var(--color-err))" } : undefined}
          onClick={message.dismiss}
        >
          {message.text}
          {message.action ? (
            <button
              type="button"
              className="odk-status-btn"
              style={{ marginLeft: 10 }}
              onClick={(event) => {
                event.stopPropagation();
                message.dismiss();
                message.action!.run();
              }}
            >
              {message.action.label}
            </button>
          ) : null}
        </span>
      ) : first ? (
        <>
          <StatusBadge>{waiting.length > 1 ? `${waiting.length} waiting` : "waiting"}</StatusBadge>
          <span className="odk-status-text" data-testid="status-waiting-terminal">
            {name(first)} · confirmation requested
          </span>
          <button
            type="button"
            className="odk-status-btn"
            data-testid="status-waiting-enter"
            aria-label={`Send Enter to ${displayTerminalTitle(first)}`}
            title="Confirm the currently selected option in this terminal"
            disabled={!deviceId || !canSend(first.machine_id) || enter.sent.has(first.id)}
            onClick={() => void enter.send(first)}
          >
            {enter.sent.has(first.id)
              ? enter.result[first.id] === "sent" ? "sent" : enter.result[first.id] === "check" ? "check" : "…"
              : <><span className="odk-bracket" aria-hidden="true">[</span>enter<span className="odk-bracket" aria-hidden="true">]</span></>}
          </button>
          <button
            type="button"
            className="odk-status-btn odk-status-btn--quiet"
            data-testid="status-waiting-open"
            aria-label={`Open ${displayTerminalTitle(first)}`}
            onClick={() => onOpenTerminal(first)}
          >
            open ↵
          </button>
          {enter.error ? (
            <span role="alert" className="odk-status-text" style={{ color: "rgb(var(--color-err))" }}>
              {enter.error}
            </span>
          ) : null}
        </>
      ) : browserWaiting ? (
        <>
          <StatusBadge>waiting</StatusBadge>
          <span className="odk-status-text" data-testid="status-waiting-browser">
            browser · {browserWaiting.label}{browserWaiting.reason ? ` · ${browserWaiting.reason}` : ""}
          </span>
          <button type="button" className="odk-status-btn odk-status-btn--quiet" onClick={browserWaiting.open}>
            open ↵
          </button>
        </>
      ) : sizeNotice ? (
        <>
          <span className="odk-status-text" data-testid="terminal-size-banner" style={{ color: "rgb(var(--color-fg-2))" }}>
            sized by another device · {sizeNotice.cols}×{sizeNotice.rows}
          </span>
          <button
            type="button"
            className="odk-status-btn"
            disabled={!sizeNotice.canFit}
            onClick={sizeNotice.fit}
          >
            <span aria-hidden="true">[</span>
            {sizeNotice.isController ? "fit to this window" : "take control and fit"}
            <span aria-hidden="true">]</span>
          </button>
        </>
      ) : null}
      <span className="odk-status-fill" />
      {prefixArmed ? (
        <span data-testid="prefix-armed-indicator" className="odk-status-muted" style={{ color: "rgb(var(--color-accent))" }}>
          ⌃B
        </span>
      ) : null}
      {update.available ? (
        <button
          type="button"
          className="odk-status-btn"
          data-testid="status-update"
          style={{ color: "rgb(var(--color-accent))" }}
          onClick={openUpdateCard}
        >
          ↑ update {update.available}
        </button>
      ) : null}
      <span className="odk-status-muted" data-testid="tab-bar-rtt">{where.join(" · ")}</span>
      {viewOnlyLocked ? (
        <button
          type="button"
          data-testid="workbench-request-control"
          className="odk-status-end odk-status-btn--end"
          onClick={onDisengageViewOnly}
          title="Unlock input claims"
        >
          view only · unlock
        </button>
      ) : !isController ? (
        <>
          <span className="odk-status-muted">watching</span>
          <button
            type="button"
            data-testid="workbench-request-control"
            className="odk-status-end odk-status-end--active odk-status-btn--end"
            onClick={onRequestControl}
            title="Take control"
          >
            take control
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            data-testid="workbench-view-only-lock"
            className="odk-status-btn odk-status-btn--quiet"
            onClick={onEngageViewOnly}
            title="Lock to view only"
            aria-label="Lock to view only"
          >
            lock
          </button>
          <StatusEnd active testId="status-in-control">in control</StatusEnd>
        </>
      )}
    </StatusLine>
  );
}

function usePaneSizeNotice() {
  const [notice, setNotice] = useState<PaneSizeNotice | null>(null);
  useEffect(() => subscribePaneSizeNotice(setNotice), []);
  return notice;
}

function useWorkspaceMessage() {
  const [message, setMessage] = useState<(WorkspaceMessage & { dismiss: () => void }) | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribeWorkspaceMessages((next) => {
      clearTimeout(timer);
      const dismiss = () => setMessage((current) => (current?.id === next.id ? null : current));
      setMessage({ ...next, dismiss });
      if (next.timeoutMs > 0) timer = setTimeout(dismiss, next.timeoutMs);
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, []);
  return message;
}

/** One Enter to a waiting terminal, never retried; the same rules as the
 *  phone's attention strip (lib/attentionEnter.ts). */
function useAttentionEnter(
  pending: TerminalInfo[],
  deviceId: string | null,
  canSend: (machineId: string) => boolean,
) {
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
  const pendingKey = pending.map((t) => t.id).join(",");
  useEffect(() => {
    const ids = new Set(pendingKey ? pendingKey.split(",") : []);
    setSent((previous) => ([...previous].some((id) => !ids.has(id))
      ? new Set([...previous].filter((id) => ids.has(id))) : previous));
    setResult((previous) => (Object.keys(previous).some((id) => !ids.has(id))
      ? Object.fromEntries(Object.entries(previous).filter(([id]) => ids.has(id))) : previous));
    if (!ids.size) setError(null);
  }, [pendingKey]);
  const send = async (terminal: TerminalInfo) => {
    if (sent.has(terminal.id) || requests.current.has(terminal.id) || !deviceId) return;
    const controller = new AbortController();
    requests.current.set(terminal.id, controller);
    setSent((previous) => new Set(previous).add(terminal.id));
    setError(null);
    try {
      await sendAttentionEnter({
        machineId: terminal.machine_id,
        terminalId: terminal.id,
        deviceId,
        signal: controller.signal,
        isAllowed: () => live.current.deviceId === deviceId && live.current.canSend(terminal.machine_id)
          && live.current.pending.some((t) => t.id === terminal.id),
      });
      if (!controller.signal.aborted) setResult((previous) => ({ ...previous, [terminal.id]: "sent" }));
    } catch (reason) {
      if (!controller.signal.aborted) {
        setResult((previous) => ({ ...previous, [terminal.id]: "check" }));
        setError(reason instanceof Error ? reason.message : "Open the terminal to check.");
      }
    } finally {
      requests.current.delete(terminal.id);
    }
  };
  return { sent, result, error, send };
}
