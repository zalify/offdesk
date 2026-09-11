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
  const inputs: { path: string; message: { type: string; data?: string } }[] = [];
  await page.routeWebSocket(/\/ws\/terminal\//, socket => {
    socket.onMessage(raw => {
      if (typeof raw === "string") inputs.push({ path: new URL(socket.url()).pathname, message: JSON.parse(raw) });
    });
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
  const routeBefore = page.url();
  const focusBefore = await page.evaluateHandle(() => document.activeElement);
  const remoteEnter = page.getByTestId("mobile-attention-enter-remote");
  await remoteEnter.click();
  await expect(remoteEnter).toHaveText("Sent");
  await expect(remoteEnter).toBeDisabled();
  expect(page.url()).toBe(routeBefore);
  await expect(page.getByTestId("mobile-title-bar-label")).toContainText("Current task");
  expect(inputs.filter(x => x.message.type === "command_input")).toEqual([
    { path: "/ws/terminal/remote-host/remote", message: { type: "command_input", data: "\r" } },
  ]);
  expect(inputs.filter(x => x.path.endsWith("/remote") && x.message.type === "resize")).toEqual([]);
  expect(await page.evaluate(element => document.activeElement === element, focusBefore)).toBe(true);
  await focusBefore.dispose();
  await expect(page.getByTestId("mobile-attention-enter-other")).toBeEnabled();
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


test("missed attention events recover without another message or manual reconnect", async ({ page }) => {
  let bootstrapCount = 0;
  let socket: WebSocketRoute;
  const terminals = ["current", "waiting"].map(id => ({ id, title: id, machine_id: "e2e-node", cwd: "/tmp", cols: 80, rows: 24, reachable: true }));
  await page.route("**/api/bootstrap", route => {
    bootstrapCount++;
    return route.fulfill({ json: {
      snapshot_seq: bootstrapCount === 1 ? 100 : 103,
      last_focused_terminal_id: "current",
      machines: [{ id: "e2e-node", name: "Mac", os: "macos", home_dir: "/tmp" }],
      terminals: terminals.map(t => ({ ...t, attention: bootstrapCount > 1 && t.id === "waiting" ? "confirmation" : null })),
      workspace_groups: [], workspace_layouts: [], machine_stats: [], control_leases: [],
    } });
  });
  await page.routeWebSocket(/\/ws\/events/, ws => { socket = ws; });
  await page.routeWebSocket(/\/ws\/terminal\//, ws => ws.send(Buffer.from("ready\r\n")));
  await openApp(page);
  const strip = page.getByTestId("mobile-terminal-attention");
  await expect(page.getByTestId("mobile-title-bar-label")).toContainText("current");
  await expect(strip).toHaveCount(0);
  // Warm the state queue first: subsequent updater execution can be deferred.
  socket!.send(JSON.stringify({ seq: 101, event: { type: "terminal_updated", terminal: terminals[0] } }));
  socket!.send(JSON.stringify({ seq: 103, event: { type: "terminal_updated", terminal: terminals[0] } }));
  await expect.poll(() => bootstrapCount).toBeGreaterThan(1);
  await expect(strip).toContainText("1 waiting");
  await page.getByTestId("mobile-attention-waiting").click();
  await expect(page).toHaveURL(/#\/t\/waiting$/);
  await expect(strip).toHaveCount(0);
});


test("mobile attention Enter respects view-only and a prompt resolved while attaching", async ({ page }) => {
  const current = { id: "current", title: "Current", machine_id: "e2e-node", cwd: "/tmp", cols: 80, rows: 24, reachable: true };
  const waiting = { ...current, id: "waiting", title: "Waiting", attention: "confirmation" };
  let events: WebSocketRoute;
  let waitingSocket: WebSocketRoute | undefined;
  const inputs: string[] = [];
  await page.addInitScript(() => {
    if (localStorage.getItem("offdesk:view-only-lock") === null) localStorage.setItem("offdesk:view-only-lock", "1");
  });
  await page.route("**/api/bootstrap", route => route.fulfill({ json: {
    snapshot_seq: 100, last_focused_terminal_id: "current",
    machines: [{ id: "e2e-node", name: "Mac", os: "macos", home_dir: "/tmp" }],
    terminals: [current, waiting], workspace_groups: [], workspace_layouts: [], machine_stats: [], control_leases: [],
  } }));
  await page.routeWebSocket(/\/ws\/events/, socket => { events = socket; });
  await page.routeWebSocket(/\/ws\/terminal\//, socket => {
    if (new URL(socket.url()).pathname.endsWith("/waiting")) {
      waitingSocket = socket;
      socket.onMessage(raw => inputs.push(String(raw)));
    } else socket.send(Buffer.from("Ready\r\n"));
  });
  await openApp(page);
  await expect(page.getByTestId("mobile-attention-enter-waiting")).toBeDisabled();
  expect(waitingSocket).toBeUndefined();
  // Unlock for the next load without changing the selected terminal.
  await page.evaluate(() => localStorage.setItem("offdesk:view-only-lock", "0"));
  await page.reload();
  const button = page.getByTestId("mobile-attention-enter-waiting");
  await expect(button).toBeEnabled();
  await button.click();
  await expect.poll(() => !!waitingSocket).toBe(true);
  await expect(button).toBeDisabled();
  events!.send(JSON.stringify({ seq: 101, event: { type: "terminal_updated", terminal: { ...waiting, attention: null } } }));
  await expect(page.getByTestId("mobile-terminal-attention")).toHaveCount(0);
  const closed = new Promise<void>(resolve => waitingSocket!.onClose(() => resolve()));
  waitingSocket!.send(Buffer.from("Now at an ordinary shell prompt\r\n"));
  await closed;
  expect(inputs).toEqual([]);
  await expect(page.getByTestId("mobile-title-bar-label")).toContainText("Current");
});
