// Adaptive Mosh-style local echo prediction for high-RTT remote terminals.
//
// Physics: over a 100-200ms WAN link, waiting for the remote shell/agent to
// echo every keystroke makes typing feel sticky no matter how fast the backend
// is. This pure state machine predicts printable ASCII keystrokes and
// backspaces in a lightweight read-only overlay above xterm's cursor — never
// mutating xterm's buffer.
//
// Safety invariants:
// - Adaptive: stays completely dormant while observed echo RTT < 35ms (zero
//   visual change on localhost, LAN, or E2E runs).
// - Normal buffer only: immediately clears and refuses prediction in alternate
//   screen apps (vim, less, htop, full-screen TUIs).
// - Authoritative server: any non-matching or escape-bearing output from the
//   server clears the prediction immediately; exact ASCII prefix echoes advance
//   the prediction window without flicker.
// - Auto-expire: unconfirmed predictions clear after 1500ms (e.g. password
//   prompts with echo off).

const ACTIVATION_RTT_MS = 35;
const DEACTIVATION_RTT_MS = 22;
const RTT_EMA_ALPHA = 0.25;
const MAX_RTT_SAMPLE_MS = 2000;
const MAX_PREDICT_CHARS = 64;
const PREDICTION_TTL_MS = 1500;

export interface LocalEchoCursor {
  col: number;
  row: number;
  cols: number;
  alternateScreen: boolean;
}

export interface LocalEchoSnapshot {
  text: string;
  startCol: number;
  startRow: number;
  rttMs: number | null;
  active: boolean;
}

export interface LocalEchoController {
  onInput(data: string, cursor: LocalEchoCursor, nowMs?: number): LocalEchoSnapshot;
  onOutput(chunk: Uint8Array, nowMs?: number): LocalEchoSnapshot;
  reset(): LocalEchoSnapshot;
  snapshot(nowMs?: number): LocalEchoSnapshot;
}

function isPrintableAscii(code: number): boolean {
  return code >= 0x20 && code <= 0x7e;
}

export function createLocalEchoController(
  now: () => number = () => performance.now(),
): LocalEchoController {
  let text = "";
  let startCol = 0;
  let startRow = 0;
  let startedAt = 0;
  let lastSentAt: number | null = null;
  let rttMs: number | null = null;
  let active = false;

  const clear = () => {
    text = "";
    startedAt = 0;
  };

  const snap = (nowMs: number): LocalEchoSnapshot => {
    if (text && nowMs - startedAt > PREDICTION_TTL_MS) {
      clear();
    }
    return { text, startCol, startRow, rttMs, active };
  };

  return {
    onInput(data: string, cursor: LocalEchoCursor, nowMs = now()): LocalEchoSnapshot {
      if (data.length === 0) return snap(nowMs);
      // Only measure RTT on single-character / short typing inputs, not mouse reports.
      if (data.charCodeAt(0) !== 0x1b && lastSentAt === null) {
        lastSentAt = nowMs;
      }
      if (cursor.alternateScreen || !active) {
        clear();
        return snap(nowMs);
      }
      if (data.length !== 1) {
        clear();
        return snap(nowMs);
      }
      const code = data.charCodeAt(0);
      if (code === 0x7f) {
        if (text.length > 0) {
          text = text.slice(0, -1);
          if (!text) startedAt = 0;
        }
        return snap(nowMs);
      }
      if (!isPrintableAscii(code)) {
        clear();
        return snap(nowMs);
      }
      if (!text) {
        startCol = cursor.col;
        startRow = cursor.row;
        startedAt = nowMs;
      }
      if (
        text.length < MAX_PREDICT_CHARS &&
        startCol + text.length < Math.max(1, cursor.cols - 1)
      ) {
        text += data;
      }
      return snap(nowMs);
    },

    onOutput(chunk: Uint8Array, nowMs = now()): LocalEchoSnapshot {
      if (lastSentAt !== null) {
        const sample = nowMs - lastSentAt;
        lastSentAt = null;
        if (sample > 0 && sample < MAX_RTT_SAMPLE_MS) {
          rttMs =
            rttMs === null
              ? sample
              : rttMs + RTT_EMA_ALPHA * (sample - rttMs);
          if (!active && rttMs >= ACTIVATION_RTT_MS) {
            active = true;
          } else if (active && rttMs <= DEACTIVATION_RTT_MS) {
            active = false;
            clear();
          }
        }
      }
      if (!text || chunk.length === 0) {
        return snap(nowMs);
      }
      // If the server echoed an exact ASCII prefix of our predicted text,
      // advance the prediction window cleanly so remaining typed characters
      // don't flicker while still in flight.
      let matched = 0;
      while (
        matched < chunk.length &&
        matched < text.length &&
        chunk[matched] === text.charCodeAt(matched)
      ) {
        matched += 1;
      }
      if (matched === chunk.length && matched > 0) {
        text = text.slice(matched);
        startCol += matched;
        if (!text) startedAt = 0;
        return snap(nowMs);
      }
      clear();
      return snap(nowMs);
    },

    reset(): LocalEchoSnapshot {
      clear();
      lastSentAt = null;
      return { text, startCol, startRow, rttMs, active };
    },

    snapshot(nowMs = now()): LocalEchoSnapshot {
      return snap(nowMs);
    },
  };
}
