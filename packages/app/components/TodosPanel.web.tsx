import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { AgentTasks, MachineInfo, RelayAgent, RelayTask, TerminalInfo, TodoInfo } from "@offdesk/shared";
import { ChevronDown, ChevronLeft, ChevronRight, Folder, Plus, X } from "lucide-react";
import { createTodo, deleteTodo, updateTodo } from "@/lib/api";
import { agentLabel } from "@/lib/agentRelay";
import { colors, colorAlpha } from "@/lib/colors";
import {
  agentLooksFinished,
  cleanTitle,
  composeTodoPrompt,
  doneTodos,
  draftTodo,
  folderLabel,
  openTodos,
  todoAgentState,
  unlinkedAgentTerminals,
  type TodoAgentState,
} from "@/lib/todos";
import { newUuid } from "@/lib/uuid";

interface TodosPanelProps {
  todos: TodoInfo[];
  machines: MachineInfo[];
  /** Live terminals, for agent progress and task lists. */
  terminals: TerminalInfo[];
  /** Where the active terminal is, offered as a to-do's location. */
  defaultLocation?: { machineId: string; cwd: string };
  /** Starting an agent creates a terminal, which needs machine control. */
  canDispatch: (machineId: string) => boolean;
  /** Start the agent; the canvas then shows its terminal. */
  onDispatch: (todo: TodoInfo, agent: RelayAgent, prompt: string) => Promise<void>;
  onOpenTerminal: (terminalId: string) => void;
  /** Apply a change locally right away; the Hub's event confirms it. */
  onLocalUpsert: (todo: TodoInfo) => void;
  onLocalRemove: (id: string) => void;
  onClose: () => void;
}

const message = (reason: unknown) =>
  reason instanceof Error ? reason.message.replace(/^\d+: /, "") : "Something went wrong.";

const iconButton: CSSProperties = {
  width: 44,
  height: 44,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
  border: 0,
  borderRadius: 10,
  background: "transparent",
  color: colors.foreground,
  cursor: "pointer",
  flexShrink: 0,
};

const field: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  minHeight: 44,
  padding: "0 12px",
  borderRadius: 10,
  border: `1px solid ${colors.border}`,
  background: colors.background,
  color: colors.foreground,
  fontSize: 16,
  fontFamily: "inherit",
};

const label: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  fontSize: 12,
  fontWeight: 500,
  color: colors.foregroundSecondary,
};

const sectionTitle: CSSProperties = {
  margin: 0,
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: colors.foregroundSecondary,
};

/** The user's own to-dos, kept by the Hub and synced to every device. */
export function TodosPanel({
  todos,
  machines,
  terminals,
  defaultLocation,
  canDispatch,
  onDispatch,
  onOpenTerminal,
  onLocalUpsert,
  onLocalRemove,
  onClose,
}: TodosPanelProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [newTitle, setNewTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const open = useMemo(() => openTodos(todos), [todos]);
  const done = useMemo(() => doneTodos(todos), [todos]);
  const detail = detailId ? todos.find((todo) => todo.id === detailId) ?? null : null;
  const homeDirs = useMemo(() => new Map(machines.map((m) => [m.id, m.home_dir])), [machines]);
  const agentTerminals = useMemo(() => unlinkedAgentTerminals(terminals, todos), [terminals, todos]);

  const adopt = async (terminal: TerminalInfo) => {
    const title = cleanTitle(terminal.title) || "Agent task";
    setError(null);
    try {
      onLocalUpsert(
        await createTodo({ id: newUuid(), title, machine_id: terminal.machine_id, terminal_id: terminal.id }),
      );
    } catch (reason) {
      setError(`Couldn't add "${title}": ${message(reason)}`);
    }
  };

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  // A to-do deleted on another device closes its detail view here.
  useEffect(() => {
    if (detailId && !detail) setDetailId(null);
  }, [detail, detailId]);

  const add = async () => {
    const title = cleanTitle(newTitle);
    if (!title) return;
    const id = newUuid();
    // updated_at 0: the Hub's copy always replaces this draft.
    onLocalUpsert({ ...draftTodo(id, title, todos), updated_at: 0 });
    setNewTitle("");
    setError(null);
    try {
      onLocalUpsert(await createTodo({ id, title }));
    } catch (reason) {
      onLocalRemove(id);
      setNewTitle(title);
      setError(`Couldn't add "${title}": ${message(reason)}`);
    }
  };

  const toggle = async (todo: TodoInfo) => {
    const status = todo.status === "open" ? "done" : "open";
    onLocalUpsert({ ...todo, status, completed_at: status === "done" ? Date.now() : undefined });
    setError(null);
    try {
      onLocalUpsert(await updateTodo(todo.id, { status }));
    } catch (reason) {
      onLocalUpsert(todo);
      setError(`Couldn't update "${todo.title}": ${message(reason)}`);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="todos-dialog"
      data-testid="todos-panel"
      aria-labelledby="todos-title"
      onClose={onClose}
    >
      {detail ? (
        <TodoDetail
          key={detail.id}
          todo={detail}
          machines={machines}
          agentState={todoAgentState(detail, terminals)}
          defaultLocation={defaultLocation}
          canDispatch={canDispatch}
          onDispatch={onDispatch}
          onOpenTerminal={onOpenTerminal}
          onBack={() => setDetailId(null)}
          onLocalUpsert={onLocalUpsert}
          onDeleted={(id) => {
            onLocalRemove(id);
            setDetailId(null);
          }}
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 8px 10px 16px", borderBottom: `1px solid ${colors.border}` }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <h1 id="todos-title" style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>To-dos</h1>
              <div style={{ fontSize: 12, color: colors.foregroundSecondary }}>Saved on your Hub · synced to your devices</div>
            </div>
            <button type="button" aria-label="Close" style={iconButton} onClick={() => dialogRef.current?.close()}>
              <X size={20} />
            </button>
          </div>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              void add();
            }}
            style={{ display: "flex", gap: 8, padding: "12px 16px" }}
          >
            <label style={{ ...field, flex: 1, display: "flex", alignItems: "center", gap: 8, padding: "0 12px" }}>
              <Plus size={18} aria-hidden="true" />
              <input
                ref={inputRef}
                data-testid="todo-new-input"
                aria-label="New to-do"
                placeholder="Add a to-do"
                value={newTitle}
                enterKeyHint="done"
                onChange={(event) => setNewTitle(event.target.value)}
                style={{ flex: 1, minWidth: 0, border: 0, outline: 0, background: "transparent", color: colors.foreground, fontSize: 16, fontFamily: "inherit" }}
              />
            </label>
            <button
              type="submit"
              data-testid="todo-add"
              disabled={!cleanTitle(newTitle)}
              style={{ minHeight: 44, padding: "0 14px", border: 0, borderRadius: 10, background: colors.accent, color: colors.onAccent, fontWeight: 600, fontSize: 15, cursor: "pointer", opacity: cleanTitle(newTitle) ? 1 : 0.5 }}
            >
              Add
            </button>
          </form>

          {error && (
            <div role="alert" style={{ margin: "0 16px 8px", fontSize: 13, color: colors.danger }}>
              {error}
            </div>
          )}

          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "0 16px 16px" }}>
            <h2 style={sectionTitle}>My to-dos · {open.length}</h2>
            {open.length === 0 && (
              <p style={{ margin: "12px 0", fontSize: 14, color: colors.foregroundSecondary }}>Nothing open. Add the next thing above.</p>
            )}
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {open.map((todo) => (
                <TodoRow key={todo.id} todo={todo} agentState={todoAgentState(todo, terminals)} homeDir={todo.machine_id ? homeDirs.get(todo.machine_id) : undefined} onToggle={toggle} onOpen={setDetailId} />
              ))}
            </ul>

            {done.length > 0 && (
              <>
                <button
                  type="button"
                  data-testid="todos-done-toggle"
                  aria-expanded={showDone}
                  onClick={() => setShowDone((value) => !value)}
                  style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", minHeight: 44, marginTop: 8, padding: 0, border: 0, background: "transparent", color: colors.foregroundSecondary, fontSize: 14, cursor: "pointer" }}
                >
                  <span>Done · {done.length}</span>
                  <ChevronDown size={18} style={{ transform: showDone ? "rotate(180deg)" : undefined }} />
                </button>
                {showDone && (
                  <ul style={{ listStyle: "none", margin: 0, padding: 0 }} data-testid="todos-done-list">
                    {done.map((todo) => (
                      <TodoRow key={todo.id} todo={todo} agentState={todoAgentState(todo, terminals)} homeDir={todo.machine_id ? homeDirs.get(todo.machine_id) : undefined} onToggle={toggle} onOpen={setDetailId} />
                    ))}
                  </ul>
                )}
              </>
            )}

            {agentTerminals.length > 0 && (
              <>
                <h2 style={{ ...sectionTitle, marginTop: 20 }}>Agent tasks · not in your list</h2>
                <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 10 }}>
                  {agentTerminals.map((terminal) => (
                    <AgentTasksCard
                      key={terminal.id}
                      terminal={terminal}
                      homeDir={homeDirs.get(terminal.machine_id)}
                      onAdopt={() => void adopt(terminal)}
                      onOpen={() => onOpenTerminal(terminal.id)}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </dialog>
  );
}

function TodoRow({
  todo,
  agentState,
  homeDir,
  onToggle,
  onOpen,
}: {
  todo: TodoInfo;
  agentState: TodoAgentState;
  homeDir?: string;
  onToggle: (todo: TodoInfo) => void;
  onOpen: (id: string) => void;
}) {
  const doneItem = todo.status === "done";
  const finished = agentLooksFinished(todo, agentState);
  return (
    <li data-testid={`todo-row-${todo.id}`} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 4, borderBottom: `1px solid ${colors.border}` }}>
      <label style={{ width: 44, minHeight: 52, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, cursor: "pointer" }}>
        <input
          type="checkbox"
          data-testid={`todo-toggle-${todo.id}`}
          checked={doneItem}
          onChange={() => onToggle(todo)}
          aria-label={`${doneItem ? "Reopen" : "Done"}: ${todo.title}`}
          style={{ width: 22, height: 22, margin: 0, accentColor: colors.accent }}
        />
      </label>
      <button
        type="button"
        data-testid={`todo-open-${todo.id}`}
        onClick={() => onOpen(todo.id)}
        style={{ flex: 1, minWidth: 0, minHeight: 52, display: "flex", alignItems: "center", gap: 8, padding: "8px 0", border: 0, background: "transparent", color: colors.foreground, textAlign: "left", cursor: "pointer", fontFamily: "inherit" }}
      >
        <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 15, fontWeight: 500, overflowWrap: "anywhere", textDecoration: doneItem ? "line-through" : undefined, color: doneItem ? colors.foregroundSecondary : colors.foreground }}>
            {todo.title}
          </span>
          {(todo.cwd || todo.notes || todo.agent) && (
            <span style={{ display: "flex", flexWrap: "wrap", gap: 10, fontSize: 12, color: colors.foregroundSecondary, minWidth: 0 }}>
              {todo.agent && <AgentBadge agent={todo.agent} state={agentState} />}
              {todo.cwd && (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
                  <Folder size={12} aria-hidden="true" />
                  {folderLabel(todo.cwd, homeDir)}
                </span>
              )}
              {todo.notes && <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{todo.notes}</span>}
            </span>
          )}
        </span>
        <ChevronRight size={18} aria-hidden="true" style={{ color: colors.foregroundSecondary, flexShrink: 0 }} />
      </button>
      {finished && todo.agent && (
        <div
          data-testid={`todo-finished-${todo.id}`}
          style={{ flexBasis: "100%", display: "flex", alignItems: "center", gap: 8, margin: "0 0 10px 48px", padding: "6px 6px 6px 10px", borderRadius: 10, border: `1px dashed ${colors.border}` }}
        >
          <span style={{ flex: 1, fontSize: 13 }}>
            {agentLabel(todo.agent)} finished all {agentState.kind !== "none" ? agentState.tasks?.total : ""} tasks. Mark done?
          </span>
          <button
            type="button"
            onClick={() => onToggle(todo)}
            style={{ minHeight: 44, padding: "0 12px", border: 0, borderRadius: 8, background: colors.accent, color: colors.onAccent, fontWeight: 600, cursor: "pointer" }}
          >
            Mark done
          </button>
        </div>
      )}
    </li>
  );
}

function progressLabel(tasks?: AgentTasks) {
  return tasks && tasks.total > 0 ? ` · ${tasks.done}/${tasks.total}` : "";
}

function AgentBadge({ agent, state }: { agent: RelayAgent; state: TodoAgentState }) {
  const status =
    state.kind === "working"
      ? "working"
      : state.kind === "waiting"
        ? "needs you"
        : state.kind === "idle"
          ? "idle"
          : "stopped";
  return (
    <span
      data-testid="todo-agent-badge"
      style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "1px 8px", borderRadius: 999, border: `1px solid ${colors.border}`, color: colors.foreground, fontWeight: 600 }}
    >
      <span style={{ width: 7, height: 7, borderRadius: 4, background: state.kind === "waiting" ? colors.warning : state.kind === "working" ? colors.accent : colors.foregroundMuted }} />
      {agentLabel(agent)} · {status}
      {state.kind !== "none" && progressLabel(state.tasks)}
    </span>
  );
}

function TaskList({ items }: { items: RelayTask[] }) {
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
      {items.map((task, index) => (
        <li
          key={`${index}-${task.subject}`}
          style={{ display: "flex", gap: 8, alignItems: "baseline", color: task.status === "completed" ? colors.foregroundSecondary : colors.foreground, textDecoration: task.status === "completed" ? "line-through" : undefined }}
        >
          <span aria-hidden="true" style={{ width: 14, flexShrink: 0, textAlign: "center" }}>
            {task.status === "completed" ? "✓" : task.status === "in_progress" ? "■" : "□"}
          </span>
          <span>
            <span style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
              {task.status === "completed" ? "Done: " : task.status === "in_progress" ? "In progress: " : "Pending: "}
            </span>
            {task.subject}
          </span>
        </li>
      ))}
    </ul>
  );
}

function AgentTasksCard({
  terminal,
  homeDir,
  onAdopt,
  onOpen,
}: {
  terminal: TerminalInfo;
  homeDir?: string;
  onAdopt: () => void;
  onOpen: () => void;
}) {
  const agent = terminal.agent!;
  const tasks = agent.tasks!;
  return (
    <section
      aria-label={terminal.title}
      data-testid={`agent-tasks-${terminal.id}`}
      style={{ border: `1px solid ${colors.border}`, borderRadius: 12, padding: 12, display: "flex", flexDirection: "column", gap: 10 }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 600, overflowWrap: "anywhere" }}>{terminal.title}</div>
          <div style={{ fontSize: 12, color: colors.foregroundSecondary, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
            {folderLabel(terminal.cwd, homeDir)} · {agentLabel(agent.kind)}
            {agent.activity ? ` · ${agent.activity === "waiting" ? "needs you" : agent.activity === "busy" ? "working" : "idle"}` : ""}
          </div>
        </div>
        <span style={{ flexShrink: 0, padding: "1px 8px", borderRadius: 999, border: `1px solid ${colors.border}`, fontSize: 12, fontWeight: 600 }}>
          {tasks.done}/{tasks.total}
        </span>
      </div>
      <TaskList items={tasks.items.slice(0, 5)} />
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" data-testid="agent-tasks-adopt" onClick={onAdopt} style={{ flex: 1, minHeight: 44, borderRadius: 8, border: `1px solid ${colors.border}`, background: "transparent", color: colors.foreground, fontWeight: 600, cursor: "pointer" }}>
          Add to my to-dos
        </button>
        <button type="button" onClick={onOpen} style={{ flex: 1, minHeight: 44, borderRadius: 8, border: `1px solid ${colors.border}`, background: "transparent", color: colors.foreground, fontWeight: 600, cursor: "pointer" }}>
          Open terminal
        </button>
      </div>
    </section>
  );
}

function TodoDetail({
  todo,
  machines,
  agentState,
  defaultLocation,
  canDispatch,
  onDispatch,
  onOpenTerminal,
  onBack,
  onLocalUpsert,
  onDeleted,
}: {
  todo: TodoInfo;
  machines: MachineInfo[];
  agentState: TodoAgentState;
  defaultLocation?: { machineId: string; cwd: string };
  canDispatch: (machineId: string) => boolean;
  onDispatch: (todo: TodoInfo, agent: RelayAgent, prompt: string) => Promise<void>;
  onOpenTerminal: (terminalId: string) => void;
  onBack: () => void;
  onLocalUpsert: (todo: TodoInfo) => void;
  onDeleted: (id: string) => void;
}) {
  const [dispatchAgent, setDispatchAgent] = useState<RelayAgent | null>(null);
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState(todo.title);
  const [notes, setNotes] = useState(todo.notes);
  const [machineId, setMachineId] = useState(todo.machine_id ?? "");
  const [cwd, setCwd] = useState(todo.cwd ?? "");
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cleaned = cleanTitle(title);
  const changed =
    cleaned !== todo.title ||
    notes.trim() !== todo.notes ||
    machineId !== (todo.machine_id ?? "") ||
    cwd.trim() !== (todo.cwd ?? "");

  const run = async (operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  };

  const located = Boolean(todo.machine_id && todo.cwd);
  const controllable = located && canDispatch(todo.machine_id!);
  const dispatchHint = !located
    ? "Choose the machine and folder, then Save, to hand this to an agent."
    : changed
      ? "Save your changes first."
      : !controllable
        ? "Take control of this machine to start an agent."
        : null;
  const startAgent = () =>
    run(async () => {
      if (!dispatchAgent) return;
      await onDispatch(todo, dispatchAgent, prompt.trim() || composeTodoPrompt(todo));
    });

  const save = () =>
    run(async () => {
      onLocalUpsert(
        await updateTodo(todo.id, {
          title: cleaned,
          notes: notes.trim(),
          machine_id: machineId || null,
          cwd: cwd.trim() || null,
        }),
      );
      onBack();
    });

  return (
    <form
      data-testid="todo-detail"
      onSubmit={(event) => {
        event.preventDefault();
        if (changed && cleaned) void save();
      }}
      style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "10px 8px", borderBottom: `1px solid ${colors.border}` }}>
        <button type="button" data-testid="todo-back" style={{ ...iconButton, width: "auto", padding: "0 10px", gap: 2, fontSize: 15 }} onClick={onBack}>
          <ChevronLeft size={18} />
          To-dos
        </button>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          data-testid="todo-delete"
          disabled={busy}
          onClick={() => {
            if (!confirmDelete) {
              setConfirmDelete(true);
              return;
            }
            void run(async () => {
              await deleteTodo(todo.id);
              onDeleted(todo.id);
            });
          }}
          style={{ ...iconButton, width: "auto", padding: "0 12px", color: colors.danger, fontSize: 15, fontWeight: confirmDelete ? 600 : 400 }}
        >
          {confirmDelete ? "Tap again to delete" : "Delete"}
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
        <label style={label}>
          Title
          <input data-testid="todo-title-input" value={title} onChange={(event) => setTitle(event.target.value)} style={field} />
        </label>
        <label style={label}>
          Notes
          <textarea
            data-testid="todo-notes-input"
            value={notes}
            rows={5}
            onChange={(event) => setNotes(event.target.value)}
            style={{ ...field, padding: "10px 12px", resize: "vertical", lineHeight: 1.4 }}
          />
        </label>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
          <label style={label}>
            Machine
            <select data-testid="todo-machine-select" value={machineId} onChange={(event) => setMachineId(event.target.value)} style={field}>
              <option value="">Not set</option>
              {machines.map((machine) => (
                <option key={machine.id} value={machine.id}>
                  {machine.name}
                </option>
              ))}
            </select>
          </label>
          <label style={label}>
            Folder
            <input
              data-testid="todo-folder-input"
              value={cwd}
              placeholder="/path/to/project"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(event) => setCwd(event.target.value)}
              style={{ ...field, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 15 }}
            />
          </label>
        </div>
        {!machineId && defaultLocation && (
          <button
            type="button"
            data-testid="todo-use-current-folder"
            onClick={() => {
              setMachineId(defaultLocation.machineId);
              setCwd(defaultLocation.cwd);
            }}
            style={{ alignSelf: "flex-start", minHeight: 44, padding: "0 4px", border: 0, background: "transparent", color: colors.accent, fontSize: 14, fontWeight: 600, cursor: "pointer" }}
          >
            Use the current terminal's folder
          </button>
        )}

        <section aria-label="Agent" data-testid="todo-agent-section" style={{ display: "flex", flexDirection: "column", gap: 10, padding: 12, borderRadius: 12, border: `1px solid ${colors.border}` }}>
          {todo.agent && agentState.kind !== "none" ? (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <AgentBadge agent={todo.agent} state={agentState} />
                {agentState.kind === "stopped" && (
                  <span style={{ fontSize: 12, color: colors.foregroundSecondary }}>Its terminal is closed.</span>
                )}
              </div>
              {agentState.tasks && agentState.tasks.items.length > 0 ? (
                <TaskList items={agentState.tasks.items} />
              ) : (
                <span style={{ fontSize: 13, color: colors.foregroundSecondary }}>
                  No task list yet. Progress appears when {agentLabel(todo.agent)} plans its steps.
                </span>
              )}
              {agentState.kind !== "stopped" && todo.terminal_id && (
                <button
                  type="button"
                  data-testid="todo-open-terminal"
                  onClick={() => onOpenTerminal(todo.terminal_id!)}
                  style={{ minHeight: 44, borderRadius: 8, border: `1px solid ${colors.border}`, background: "transparent", color: colors.foreground, fontWeight: 600, cursor: "pointer" }}
                >
                  Open terminal
                </button>
              )}
            </>
          ) : (
            <span style={{ fontSize: 13, color: colors.foregroundSecondary }}>Hand this to an agent to work on it in its folder.</span>
          )}

          {dispatchAgent ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <label style={label}>
                First message for {agentLabel(dispatchAgent)}
                <textarea
                  data-testid="todo-dispatch-prompt"
                  value={prompt}
                  rows={5}
                  readOnly={busy}
                  onChange={(event) => setPrompt(event.target.value)}
                  style={{ ...field, padding: "10px 12px", resize: "vertical", lineHeight: 1.4 }}
                />
              </label>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" disabled={busy} onClick={() => setDispatchAgent(null)} style={{ flex: 1, minHeight: 44, borderRadius: 8, border: `1px solid ${colors.border}`, background: "transparent", color: colors.foreground, cursor: "pointer" }}>
                  Cancel
                </button>
                <button
                  type="button"
                  data-testid="todo-dispatch-start"
                  disabled={busy || !prompt.trim()}
                  onClick={() => void startAgent()}
                  style={{ flex: 2, minHeight: 44, borderRadius: 8, border: 0, background: colors.accent, color: colors.onAccent, fontWeight: 600, cursor: "pointer", opacity: busy || !prompt.trim() ? 0.5 : 1 }}
                >
                  {busy ? `Starting ${agentLabel(dispatchAgent)}…` : `Start ${agentLabel(dispatchAgent)}`}
                </button>
              </div>
              <span style={{ fontSize: 12, color: colors.foregroundSecondary }}>
                Opens a new tab in {todo.cwd}. The to-do follows {agentLabel(dispatchAgent)}'s task list.
              </span>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 8 }}>
              {(["claude", "codex"] as const).map((agent) => {
                // The same agent already on it: open its terminal instead.
                const running =
                  todo.agent === agent && Boolean(todo.terminal_id) && agentState.kind !== "stopped" && agentState.kind !== "none";
                const blocked = !running && Boolean(dispatchHint);
                return (
                  <button
                    key={agent}
                    type="button"
                    data-testid={`todo-dispatch-${agent}`}
                    disabled={busy || blocked}
                    onClick={() => {
                      if (running) {
                        onOpenTerminal(todo.terminal_id!);
                        return;
                      }
                      setPrompt(composeTodoPrompt(todo));
                      setDispatchAgent(agent);
                    }}
                    style={{ flex: 1, minHeight: 44, borderRadius: 8, border: `1px solid ${colors.border}`, background: colorAlpha.accentSubtle, color: colors.foreground, fontWeight: 600, cursor: blocked ? "not-allowed" : "pointer", opacity: blocked ? 0.5 : 1 }}
                  >
                    {running ? `Open ${agentLabel(agent)}` : `Hand off to ${agentLabel(agent)}`}
                  </button>
                );
              })}
            </div>
          )}
          {dispatchHint && !dispatchAgent && (
            <span data-testid="todo-dispatch-hint" style={{ fontSize: 12, color: colors.foregroundSecondary }}>
              {dispatchHint}
            </span>
          )}
        </section>

        {error && (
          <div role="alert" style={{ fontSize: 13, color: colors.danger }}>
            {error}
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 10, padding: "12px 16px 16px", borderTop: `1px solid ${colors.border}` }}>
        <button
          type="button"
          data-testid="todo-status"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              onLocalUpsert(await updateTodo(todo.id, { status: todo.status === "open" ? "done" : "open" }));
            })
          }
          style={{ flex: 1, minHeight: 48, borderRadius: 10, border: `1px solid ${colors.border}`, background: "transparent", color: colors.foreground, fontSize: 15, fontWeight: 500, cursor: "pointer" }}
        >
          {todo.status === "open" ? "Mark done" : "Reopen"}
        </button>
        <button
          type="submit"
          data-testid="todo-save"
          disabled={busy || !changed || !cleaned}
          style={{ flex: 1, minHeight: 48, borderRadius: 10, border: 0, background: colors.accent, color: colors.onAccent, fontSize: 15, fontWeight: 600, cursor: "pointer", opacity: busy || !changed || !cleaned ? 0.5 : 1 }}
        >
          Save
        </button>
      </div>
    </form>
  );
}
