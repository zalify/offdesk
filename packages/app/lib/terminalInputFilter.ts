// xterm answers in-band queries via onData. Those bytes are not keystrokes;
// if they reach the hub as `type: "input"` they claim the control lease.
// 6.0 emitted DA; 6.1 also emits color-scheme DSR, XTVERSION, window-ops
// reports, and (when DECSET 1004 is on) focus in/out.
const BROWSER_GENERATED_RESPONSE_RE = new RegExp(
  [
    "\\x1b\\[[?>][0-9;]*c",
    "\\x1b\\[\\?997;[12]n",
    "\\x1bP>\\|xterm\\.js\\([^)]*\\)\\x1b\\\\",
    "\\x1b\\[[468];[0-9]+;[0-9]+t",
    "\\x1b\\[[IO]",
    // OSC 4;n / 10-19 colour query replies. tmux >= 3.4 queries fg/bg on every
    // attach; ST or BEL terminated.
    "\\x1b\\](?:4;[0-9]+|1[0-9]);rgba?:[0-9a-fA-F/]+(?:\\x07|\\x1b\\\\)",
  ].join("|"),
  "g",
);

export function filterBrowserGeneratedTerminalInput(data: string): string {
  return data.replace(BROWSER_GENERATED_RESPONSE_RE, "");
}
