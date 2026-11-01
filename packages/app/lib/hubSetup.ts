// What a stopped hub setup says (D3): which step stopped, why, and the fix the
// app can apply itself. Pure, so every failure can be read in a test.

import type { HubPortCheck, HubStatus } from "./desktopHub";

export const SETUP_STEP_COUNT = 4;

export interface SetupFailure {
  /** The setup step that stopped, 0–3. */
  step: number;
  eyebrow: string;
  title: string;
  detail?: string;
  /** The fix, when the app has one. Without a port it's the install again. */
  fix?: { label: string; port?: number };
}

/** Which of the four steps are done, in the order they run. */
export function setupProgress(status: HubStatus): boolean[] {
  const setup = status.setup;
  return [
    setup?.hub_running ?? status.listening,
    setup?.machine_registered ?? false,
    setup?.node_online ?? false,
    setup?.tmux_available ?? false,
  ];
}

export function portFailure({ port, holder, next_free }: HubPortCheck): SetupFailure {
  const by = holder ? `${holder.name} (pid ${holder.pid})` : "another program";
  return {
    step: 0,
    eyebrow: "error: the hub didn’t start",
    title: `Port ${port} is in use by ${by}.`,
    detail: next_free
      ? "Another hub or a dev server may be running. Offdesk Dev can use the next free port instead."
      : "Another hub or a dev server may be running. Stop it, then retry.",
    fix: next_free ? { label: `Use port ${next_free} and retry`, port: next_free } : undefined,
  };
}

/** The steps before tmux have to pass for tmux to be what stopped setup. */
export function setupFailure(error: string, status: HubStatus): SetupFailure {
  const step = setupProgress(status).indexOf(false);
  if (step === 3 && status.setup) {
    return {
      step,
      eyebrow: "error: tmux didn’t start",
      title: "tmux can’t run from where the app is now.",
      detail: "The copy bundled with Offdesk Dev usually breaks when the app moves after setup. Setting the hub up again points it at the right place.",
      fix: { label: "Repair tmux and retry" },
    };
  }
  return {
    step: Math.max(step, 0),
    eyebrow: "error: setup stopped",
    title: error.replace(/^Error:\s*/, ""),
  };
}

/** For an issue. Built from checks only: no link, token or log. */
export function setupDiagnostics(status: HubStatus, failure: SetupFailure, appVersion: string | null): string {
  const names = ["hub running", "machine registered", "node online", "tmux available"];
  const checks = setupProgress(status).map((done, index) => `${done ? "[x]" : "[ ]"} ${names[index]}`);
  return [
    `Offdesk Dev ${appVersion ?? "(version unknown)"}`,
    navigator.userAgent,
    `port ${status.port ?? 4317}, ${status.listening ? "something answers" : "nothing answers"}`,
    `hub service ${status.hub_installed ? "installed" : "not installed"}, node service ${status.node_installed ? "installed" : "not installed"}`,
    ...checks,
    `stopped at step ${failure.step + 1} of ${SETUP_STEP_COUNT}: ${failure.title}`,
    ...(status.setup?.error ? [`setup check: ${status.setup.error}`] : []),
  ].join("\n");
}
