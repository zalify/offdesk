import { test, expect, devices, type WebSocketRoute } from "@playwright/test";
import type { TerminalInfo, BrowserEvent } from "@offdesk/shared";
import { openApp } from "./helpers";

test.use({ ...devices["iPhone 14"], browserName: "chromium" });

test("mobile attention shortcuts switch tabs and machines and track live resolution", async ({ page }, testInfo) => {
  let seq = 100;
  let events: WebSocketRoute;
  const terminal = (id: string, title: string, attention?: "confirmation", machine_id = "e2e-node"): TerminalInfo => ({
    id, title, machine_id, attention, cwd: `/tmp/${id}`, cols: 80, rows: 24, reachable: true,
  });
  const current = terminal("current", "Current task");
  const other = terminal("other", "Fix checkout", "confirmation");
  const remote = terminal("remote", "Review deployment", "confirmation", "remote-host");
  const offline = { ...terminal("offline", "Offline task", "confirmation"), reachable: false };
  await page.route("**/api/bootstrap", route => route.fulfill({ json: {
    snapshot_seq: seq, last_focused_terminal_id: current.id,
    machines: [
      { id: "e2e-node", name: "MacBook", os: "macos", home_dir: "/tmp" },
      { id: "remote-host", name: "Build server", os: "linux", home_dir: "/tmp" },
    ],
    terminals: [current, other, remote, offline], workspace_groups: [], workspace_layouts: [], machine_stats: [], control_leases: [],
  } }));
  await page.routeWebSocket(/\/ws\/events/, socket => {
    events = socket;
    socket.onMessage(raw => {
      if (typeof raw === "string") {
        const message = JSON.parse(raw);
        if (message.type === "ping") socket.send(JSON.stringify({ type: "pong", t: message.t }));
      }
    });
  });
  await page.routeWebSocket(/\/ws\/terminal\//, socket => {
    socket.send(Buffer.from("Terminal ready\r\n"));
  });
  await openApp(page);
  const emit = (event: BrowserEvent) => events.send(JSON.stringify({ seq: ++seq, event }));
  const strip = page.getByTestId("mobile-terminal-attention");
  await expect(strip).toContainText("2 waiting");
  await expect(page.getByTestId("mobile-attention-offline")).toHaveCount(0);
  await expect(page.getByTestId("mobile-session-switcher")).toHaveCount(0);
  await expect(page.getByText("Picked up where you left off", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("mobile-attention-light.png") });
  await page.getByTestId("mobile-attention-other").click();
  await expect(page).toHaveURL(/#\/t\/other$/);
  await expect(page.getByTestId("mobile-title-bar-label")).toContainText("Fix checkout");
  await expect(strip).toContainText("1 waiting");
  await expect(page.getByTestId("mobile-attention-other")).toHaveCount(0);
  // Opening a prompt doesn't dismiss it: it remains available after leaving.
  await page.getByTestId("mobile-attention-remote").click();
  await expect(page.getByTestId("mobile-title-bar-label")).toContainText("Build server");
  await expect(page.getByTestId("mobile-title-bar-label")).toContainText("Review deployment");
  await expect(page.getByTestId("mobile-attention-other")).toBeVisible();
  // No terminal input / control takeover is required to inspect the request.
  await expect(page.getByTestId("mobile-bar-new-terminal")).toBeDisabled();
  emit({ type: "terminal_updated", terminal: { ...other, attention: null } });
  await expect(strip).toHaveCount(0);
  emit({ type: "terminal_updated", terminal: other });
  await expect(strip).toContainText("1 waiting");
  emit({ type: "terminal_reachable_changed", machine_id: other.machine_id, terminal_id: other.id, reachable: false });
  await expect(strip).toHaveCount(0);
  emit({ type: "terminal_updated", terminal: other });
  await expect(strip).toBeVisible();
  emit({ type: "terminal_destroyed", machine_id: other.machine_id, terminal_id: other.id });
  await expect(strip).toHaveCount(0);
  await page.evaluate(() => { localStorage.setItem("offdesk:theme", "dark"); });
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(strip).toBeVisible();
  await expect(page.getByTestId("mobile-title-bar-label")).toContainText("Review deployment");
  await expect(page.getByTestId("mobile-title-bar-label")).toContainText("Build server");
  await expect(page.locator(".xterm").first()).toBeVisible();
  await expect(page.getByText("Picked up where you left off", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("mobile-attention-dark.png") });
  // Tight mobile widths and long names scroll within the strip, not the page.
  await page.setViewportSize({ width: 320, height: 640 });
  emit({ type: "terminal_created", terminal: { ...other, title: "Long terminal name ".repeat(15) } });
  await expect(strip).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("mobile-attention-narrow.png") });
});
