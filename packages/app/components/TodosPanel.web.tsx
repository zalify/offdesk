import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { MachineInfo, TodoInfo } from "@offdesk/shared";
import { ChevronDown, ChevronLeft, ChevronRight, Folder, Plus, X } from "lucide-react";
import { createTodo, deleteTodo, updateTodo } from "@/lib/api";
import { colors } from "@/lib/colors";
import { cleanTitle, doneTodos, draftTodo, folderLabel, openTodos } from "@/lib/todos";
import { newUuid } from "@/lib/uuid";

interface TodosPanelProps {
  todos: TodoInfo[];
  machines: MachineInfo[];
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
export function TodosPanel({ todos, machines, onLocalUpsert, onLocalRemove, onClose }: TodosPanelProps) {
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
                <TodoRow key={todo.id} todo={todo} homeDir={todo.machine_id ? homeDirs.get(todo.machine_id) : undefined} onToggle={toggle} onOpen={setDetailId} />
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
                  <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                    {done.map((todo) => (
                      <TodoRow key={todo.id} todo={todo} homeDir={todo.machine_id ? homeDirs.get(todo.machine_id) : undefined} onToggle={toggle} onOpen={setDetailId} />
                    ))}
                  </ul>
                )}
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
  homeDir,
  onToggle,
  onOpen,
}: {
  todo: TodoInfo;
  homeDir?: string;
  onToggle: (todo: TodoInfo) => void;
  onOpen: (id: string) => void;
}) {
  const doneItem = todo.status === "done";
  return (
    <li data-testid={`todo-row-${todo.id}`} style={{ display: "flex", alignItems: "center", gap: 4, borderBottom: `1px solid ${colors.border}` }}>
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
          {(todo.cwd || todo.notes) && (
            <span style={{ display: "flex", gap: 10, fontSize: 12, color: colors.foregroundSecondary, minWidth: 0 }}>
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
    </li>
  );
}

function TodoDetail({
  todo,
  machines,
  onBack,
  onLocalUpsert,
  onDeleted,
}: {
  todo: TodoInfo;
  machines: MachineInfo[];
  onBack: () => void;
  onLocalUpsert: (todo: TodoInfo) => void;
  onDeleted: (id: string) => void;
}) {
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
