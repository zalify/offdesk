import { terminalWsUrl } from "./api";
import { openSocket } from "./secureTransport";

/** Send one Enter to an explicitly selected background terminal. Never mount
 * xterm, resize it, focus an input, change routes, or retry an uncertain send. */
export function sendAttentionEnter(options: {
  machineId: string;
  terminalId: string;
  deviceId: string;
  isAllowed: () => boolean;
  signal: AbortSignal;
}): Promise<void> {
  const { machineId, terminalId, deviceId, isAllowed, signal } = options;
  if (signal.aborted || !deviceId || !isAllowed()) {
    return Promise.reject(new Error("This request is no longer available. Open the terminal to check."));
  }
  return new Promise((resolve, reject) => {
    const ws = openSocket(terminalWsUrl(machineId, terminalId, deviceId));
    ws.binaryType = "arraybuffer";
    let sent = false;
    let finished = false;
    let drainedAt: number | null = null;
    let drain: ReturnType<typeof setInterval> | undefined;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      clearInterval(drain);
      signal.removeEventListener("abort", abort);
      ws.onmessage = ws.onerror = ws.onclose = null;
      ws.close();
      if (error) reject(error); else resolve();
    };
    const abort = () => finish(new Error("Request changed. Open the terminal to check before trying again."));
    const timeout = setTimeout(() => finish(new Error("Connection timed out. Open the terminal to check before trying again.")), 10_000);
    signal.addEventListener("abort", abort, { once: true });
    ws.onerror = ws.onclose = () => finish(new Error("Connection lost. Open the terminal to check before trying again."));
    ws.onmessage = event => {
      if (typeof event.data === "string") {
        try {
          const message = JSON.parse(event.data);
          if (message.type === "error") finish(new Error("Could not send Enter. Open the terminal to check."));
        } catch { /* Ignore unrelated control messages. */ }
        return;
      }
      // An output frame confirms that the Node has opened the attach. Sending
      // on websocket open alone can race its PTY writer initialization.
      if (sent || finished) return;
      if (!isAllowed() || signal.aborted) { abort(); return; }
      sent = true;
      try { ws.send(JSON.stringify({ type: "command_input", data: "\r" })); }
      catch { finish(new Error("Could not send Enter. Open the terminal to check.")); return; }
      // SecureSocket queues native IPC asynchronously; don't close until its
      // queue drains. The brief grace also matches the CLI's one-shot input.
      drain = setInterval(() => {
        if (ws.bufferedAmount !== 0) { drainedAt = null; return; }
        drainedAt ??= Date.now();
        if (Date.now() - drainedAt >= 200) finish();
      }, 25);
    };
  });
}
