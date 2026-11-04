import { describe, expect, it } from "vitest";

import type { HubStatus } from "./desktopHub";
import { portFailure, setupDiagnostics, setupFailure, setupProgress } from "./hubSetup";

const status = (setup: Partial<NonNullable<HubStatus["setup"]>>): HubStatus => ({
  supported: true, bundled: true, hub_installed: true, node_installed: true, listening: true, port: 4317,
  setup: { hub_running: true, machine_registered: true, node_online: true, tmux_available: true, ...setup },
});

describe("a taken port", () => {
  it("names the holder and offers the next free port", () => {
    const failure = portFailure({ port: 4317, conflict: true, holder: { name: "node", pid: 81234 }, next_free: 4318 });
    expect(failure.step).toBe(0);
    expect(failure.title).toBe("Port 4317 is in use by node (pid 81234).");
    expect(failure.fix).toEqual({ label: "Use port 4318 and retry", port: 4318 });
  });

  it("says so plainly when the holder can't be seen and no port is free", () => {
    const failure = portFailure({ port: 4317, conflict: true, holder: null, next_free: null });
    expect(failure.title).toBe("Port 4317 is in use by another program.");
    expect(failure.fix).toBeUndefined();
  });
});

describe("a stopped setup", () => {
  it("blames tmux only when the steps before it passed", () => {
    expect(setupFailure("timed out", status({ tmux_available: false })).fix?.label).toBe("Repair tmux and retry");
    const earlier = setupFailure("timed out", status({ node_online: false, tmux_available: false }));
    expect(earlier.step).toBe(2);
    expect(earlier.fix).toBeUndefined();
  });

  it("shows the error at the first unfinished step, without its Error: prefix", () => {
    const failure = setupFailure("Error: Could not register this Mac", status({ machine_registered: false }));
    expect(failure).toMatchObject({ step: 1, title: "Could not register this Mac" });
  });

  it("falls back to the listening port on a shell without setup checks", () => {
    expect(setupProgress({ ...status({}), setup: undefined })[0]).toBe(true);
  });
});

describe("diagnostics", () => {
  it("reports the checks and the stop, and nothing secret", () => {
    const report = setupDiagnostics(status({ node_online: false, error: "Waiting for the local Hub to respond…" }), { step: 2, eyebrow: "", title: "Stopped" }, "0.25.8");
    expect(report).toContain("Offdesk Dev 0.25.8");
    expect(report).toContain("[ ] node online");
    expect(report).toContain("stopped at step 3 of 4: Stopped");
    expect(report).not.toMatch(/token|code=/);
  });
});
