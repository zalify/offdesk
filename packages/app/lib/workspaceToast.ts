// Minimal floating toast for workspace actions that are refused (pane cap
// reached, a failed "move pane to tab"). There is no toast system in the app
// yet; a keyboard shortcut that silently does nothing is indistinguishable
// from one that never registered, which is exactly the confusion the pane cap
// would otherwise create.
const TOAST_ID = "offdesk-workspace-toast";

export function showWorkspaceToast(message: string, timeoutMs = 3000): void {
  if (typeof document === "undefined") return;
  document.getElementById(TOAST_ID)?.remove();
  const div = document.createElement("div");
  div.id = TOAST_ID;
  div.dataset.testid = "workspace-toast";
  div.setAttribute("role", "status");
  div.style.cssText =
    "position:fixed;bottom:18px;left:50%;transform:translateX(-50%);" +
    "background:rgba(28,28,30,0.96);color:#f2f2f2;padding:9px 14px;" +
    "z-index:99999;font:12px/1.4 system-ui,sans-serif;border-radius:8px;" +
    "max-width:min(520px,88vw);text-align:center;pointer-events:auto;" +
    "cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,0.45);";
  div.textContent = message;
  div.addEventListener("click", () => div.remove());
  document.body.appendChild(div);
  window.setTimeout(() => {
    if (document.getElementById(TOAST_ID) === div) div.remove();
  }, timeoutMs);
}

export interface NoticeAction {
  label: string;
  run: () => void;
}

const NOTICE_ID = "offdesk-notice";

/**
 * Floating notice with an optional action button, for results the user may
 * want to act on (a saved download -> "打开"). One at a time: a new notice
 * replaces the previous one, so a progress notice becomes its own result.
 * `timeoutMs` of 0 keeps it until dismissed (progress notices are replaced).
 */
export function showNotice(
  message: string,
  opts: { action?: NoticeAction; timeoutMs?: number; tone?: "info" | "error" } = {},
): void {
  if (typeof document === "undefined") return;
  document.getElementById(NOTICE_ID)?.remove();
  const div = document.createElement("div");
  div.id = NOTICE_ID;
  div.dataset.testid = "offdesk-notice";
  div.setAttribute("role", "status");
  const border = opts.tone === "error" ? "#ff6b6b" : "transparent";
  div.style.cssText =
    "position:fixed;bottom:18px;left:50%;transform:translateX(-50%);" +
    "background:rgba(28,28,30,0.96);color:#f2f2f2;padding:9px 14px;" +
    "z-index:99999;font:12px/1.4 system-ui,sans-serif;border-radius:8px;" +
    "max-width:min(520px,88vw);text-align:center;pointer-events:auto;" +
    `box-shadow:0 4px 16px rgba(0,0,0,0.45);border:1px solid ${border};` +
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
      "background:none;border:none;color:#7cb7ff;font:inherit;font-weight:600;" +
      "cursor:pointer;padding:6px 2px;text-decoration:underline;" +
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
  const timeoutMs = opts.timeoutMs ?? (opts.action ? 10000 : 5000);
  if (timeoutMs > 0) {
    window.setTimeout(() => {
      if (document.getElementById(NOTICE_ID) === div) div.remove();
    }, timeoutMs);
  }
}
