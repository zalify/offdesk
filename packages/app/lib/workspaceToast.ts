// Short messages about workspace actions: a refused split (pane cap), a
// failed "move pane to tab", a saved download. On the desktop workspace they
// go to the status line (components/WorkspaceStatusLine.web.tsx), which
// subscribes while it is mounted; anywhere else (the phone, a settings page)
// they float above the bottom edge. A keyboard shortcut that silently does
// nothing is indistinguishable from one that never registered.

export interface NoticeAction {
  label: string;
  run: () => void;
}

export interface WorkspaceMessage {
  id: number;
  kind: "toast" | "notice";
  text: string;
  tone: "info" | "error";
  action?: NoticeAction;
  /** 0 keeps it until dismissed or replaced. */
  timeoutMs: number;
}

type Listener = (message: WorkspaceMessage) => void;
const listeners = new Set<Listener>();
let nextId = 1;

/** The status line takes messages while it is mounted. */
export function subscribeWorkspaceMessages(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function deliver(message: Omit<WorkspaceMessage, "id">): boolean {
  if (listeners.size === 0) return false;
  const full = { ...message, id: nextId++ };
  for (const listener of listeners) listener(full);
  return true;
}

const FLOAT_STYLE =
  "position:fixed;bottom:18px;left:50%;transform:translateX(-50%);" +
  "background:rgb(var(--color-bg-2));color:rgb(var(--color-fg-0));padding:9px 14px;" +
  "z-index:99999;font:12px/1.4 var(--font-display);border-radius:4px;" +
  "max-width:min(520px,88vw);text-align:center;pointer-events:auto;" +
  "box-shadow:0 12px 32px rgb(0 0 0 / .35);";

const TOAST_ID = "offdesk-workspace-toast";

export function showWorkspaceToast(message: string, timeoutMs = 3000): void {
  if (typeof document === "undefined") return;
  if (deliver({ kind: "toast", text: message, tone: "info", timeoutMs })) return;
  document.getElementById(TOAST_ID)?.remove();
  const div = document.createElement("div");
  div.id = TOAST_ID;
  div.dataset.testid = "workspace-toast";
  div.setAttribute("role", "status");
  div.style.cssText = FLOAT_STYLE + "border:1px solid rgb(var(--color-line));cursor:pointer;";
  div.textContent = message;
  div.addEventListener("click", () => div.remove());
  document.body.appendChild(div);
  window.setTimeout(() => {
    if (document.getElementById(TOAST_ID) === div) div.remove();
  }, timeoutMs);
}

const NOTICE_ID = "offdesk-notice";

/**
 * Notice with an optional action button, for results the user may want to
 * act on (a saved download -> "open"). One at a time: a new notice replaces
 * the previous one, so a progress notice becomes its own result.
 * `timeoutMs` of 0 keeps it until dismissed (progress notices are replaced).
 */
export function showNotice(
  message: string,
  opts: { action?: NoticeAction; timeoutMs?: number; tone?: "info" | "error" } = {},
): void {
  if (typeof document === "undefined") return;
  const timeoutMs = opts.timeoutMs ?? (opts.action ? 10000 : 5000);
  if (deliver({ kind: "notice", text: message, tone: opts.tone ?? "info", action: opts.action, timeoutMs })) return;
  document.getElementById(NOTICE_ID)?.remove();
  const div = document.createElement("div");
  div.id = NOTICE_ID;
  div.dataset.testid = "offdesk-notice";
  div.setAttribute("role", "status");
  const border = opts.tone === "error" ? "rgb(var(--color-err))" : "rgb(var(--color-line))";
  div.style.cssText =
    FLOAT_STYLE +
    `border:1px solid ${border};` +
    "display:flex;gap:12px;align-items:center;justify-content:center;";
  const text = document.createElement("span");
  text.textContent = message;
  // Long saved paths wrap inside the text, not by squeezing the action.
  text.style.cssText = "min-width:0;overflow-wrap:anywhere;";
  div.appendChild(text);
  if (opts.action) {
    const action = opts.action;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = action.label;
    button.style.cssText =
      "background:none;border:1px solid rgb(var(--color-line));border-radius:3px;" +
      "color:rgb(var(--color-fg-0));font:inherit;font-weight:500;" +
      "cursor:pointer;padding:4px 10px;min-height:32px;" +
      "white-space:nowrap;flex-shrink:0;";
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      div.remove();
      action.run();
    });
    div.appendChild(button);
  }
  div.addEventListener("click", () => div.remove());
  document.body.appendChild(div);
  if (timeoutMs > 0) {
    window.setTimeout(() => {
      if (document.getElementById(NOTICE_ID) === div) div.remove();
    }, timeoutMs);
  }
}
