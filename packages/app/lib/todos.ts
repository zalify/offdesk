import type { TerminalAgentKind, AgentTasks, TerminalInfo, TodoInfo } from "@offdesk/shared";

export const agentLabel = (agent: TerminalAgentKind) => (agent === "claude" ? "Claude" : "Codex");

/** Open to-dos in their manual order, newest first among equals. */
export function openTodos(todos: TodoInfo[]): TodoInfo[] {
  return todos
    .filter((todo) => todo.status === "open")
    .sort((a, b) => a.position - b.position || b.created_at - a.created_at);
}

/** Finished to-dos, most recently finished first. */
export function doneTodos(todos: TodoInfo[]): TodoInfo[] {
  return todos
    .filter((todo) => todo.status === "done")
    .sort((a, b) => (b.completed_at ?? b.updated_at) - (a.completed_at ?? a.updated_at));
}

/** A to-do as it looks before the Hub answers: on top of the open list. */
export function draftTodo(id: string, title: string, todos: TodoInfo[], now = Date.now()): TodoInfo {
  const top = todos.reduce((min, todo) => Math.min(min, todo.position), 0);
  return { id, title, notes: "", status: "open", position: top - 1, created_at: now, updated_at: now };
}

/** The last folder of a path, with the home directory shortened to `~`. */
export function folderLabel(cwd: string, homeDir?: string): string {
  const path = homeDir && (cwd === homeDir || cwd.startsWith(`${homeDir}/`)) ? `~${cwd.slice(homeDir.length)}` : cwd;
  const parts = path.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path || "/";
}

/** Server titles are one trimmed line; mirror that before sending. */
export function cleanTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim();
}

export type TodoAgentState =
  | { kind: "none" }
  | { kind: "working" | "waiting" | "idle"; tasks?: AgentTasks }
  /** The agent's terminal is gone or no longer runs the agent. */
  | { kind: "stopped"; tasks?: AgentTasks };

/** What the agent a to-do was handed to is doing now. */
export function todoAgentState(todo: TodoInfo, terminals: TerminalInfo[]): TodoAgentState {
  if (!todo.agent || !todo.terminal_id) return { kind: "none" };
  const tasks = todo.progress ?? undefined;
  const terminal = terminals.find((t) => t.id === todo.terminal_id);
  const agent = terminal?.agent;
  if (!terminal || !agent || agent.kind !== todo.agent) return { kind: "stopped", tasks };
  if (agent.activity === "waiting") return { kind: "waiting", tasks };
  if (agent.activity === "idle") return { kind: "idle", tasks };
  return { kind: "working", tasks };
}

/**
 * Offer "mark done" only when the agent finished every task it listed and
 * is no longer working. Never done automatically.
 */
export function agentLooksFinished(todo: TodoInfo, state: TodoAgentState): boolean {
  if (todo.status !== "open" || state.kind === "none") return false;
  const tasks = state.tasks;
  const allDone = Boolean(tasks && tasks.total > 0 && tasks.done === tasks.total);
  return allDone && (state.kind === "idle" || state.kind === "stopped");
}

/** Terminals whose agent keeps a task list that no to-do follows yet. */
export function unlinkedAgentTerminals(terminals: TerminalInfo[], todos: TodoInfo[]): TerminalInfo[] {
  const followed = new Set(todos.filter((t) => t.terminal_id).map((t) => t.terminal_id));
  return terminals.filter((t) => t.reachable && (t.agent?.tasks?.total ?? 0) > 0 && !followed.has(t.id));
}

/** The first message for an agent taking on a to-do. */
export function composeTodoPrompt(todo: TodoInfo): string {
  const notes = todo.notes.trim();
  return notes ? `${todo.title}\n\n${notes}` : todo.title;
}
