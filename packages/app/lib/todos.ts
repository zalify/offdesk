import type { TodoInfo } from "@offdesk/shared";

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
