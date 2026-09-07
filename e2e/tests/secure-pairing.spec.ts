import { expect, test, type Page } from "@playwright/test";

// Browser coverage of the bundled App/native boundary. Actual Noise, pairing,
// relay recording, HTTP/WS forwarding and revocation run in Rust integration
// tests; this stub never claims to verify platform Keychain or native camera.
async function bundledPhone(page: Page, initial: "new" | "paired" | "damaged" | "offline" = "new") {
  const base = test.info().project.use.baseURL as string;
  const login = await page.request.get(`${base}/api/auth/dev`);
  const { token } = await login.json();
  await page.route("http://tauri.localhost/**", async route => {
    const path = new URL(route.request().url()).pathname;
    const response = await page.request.get(base + path);
    await route.fulfill({ response });
  });
  await page.exposeFunction("__secureHttp", async (args: { method: string; path: string; body: string | null }) => {
    const response = await page.request.fetch(base + args.path, { method: args.method, data: args.body ?? undefined, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });
    return { type: "http", id: "test", status: response.status(), body: await response.text() };
  });
  await page.addInitScript(({ initial }) => {
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15" });
    const status = { endpoint: { hub_url: "https://encrypted.example", public_key: "pinned" }, device_id: "phone" };
    const routes = [
      { kind: "local", hub_url: "http://192.168.1.2:4317", available: initial !== "offline" },
      { kind: "remote", hub_url: "https://encrypted.example", available: true },
    ];
    if (initial === "offline") status.endpoint.hub_url = routes[0].hub_url;
    const sockets: { id: string; events: any }[] = [];
    const state = { routes, switchError: "", configured: (initial === "paired" || initial === "offline") || sessionStorage.getItem("test:paired") === "true", damaged: initial === "damaged", userError: initial === "offline" ? "Local network is unreachable" : "", userRequests: 0, calls: [] as string[], input: [] as unknown[] };
    Object.assign(window, { __secureTest: state });
    Object.assign(window, { __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1,
      unregisterCallback: () => {},
      invoke: async (command: string, args: any) => {
        state.calls.push(command);
        if (command === "secure_status") { if (state.damaged) throw new Error("Hub identity could not be verified"); return state.configured ? structuredClone(status) : null; }
        if (command === "secure_routes") {
          if (state.damaged) throw new Error("Cannot read saved connection routes");
          return structuredClone({ status, routes: state.routes, discovery_available: true });
        }
        if (command === "secure_switch_route") {
          if (state.switchError) throw new Error(state.switchError);
          if (!state.routes.some(route => route.hub_url === args.url && route.available)) throw new Error("Unreachable");
          status.endpoint.hub_url = args.url; state.userError = "";
          for (const socket of sockets.splice(0)) queueMicrotask(() => socket.events.onmessage({ type: "closed", id: socket.id }));
          return structuredClone(status);
        }
        if (command === "mobile_hub_url") return null;
        if (command === "secure_pair") {
          if (!args.uri.startsWith("offdesk://pair?")) throw new Error("Invalid code");
          state.configured = true; sessionStorage.setItem("test:paired", "true"); return structuredClone(status);
        }
        if (command === "secure_forget") { state.configured = false; state.damaged = false; sessionStorage.removeItem("test:paired"); return; }
        if (command === "secure_request") {
          if (args.path === "/api/auth/me") { state.userRequests++; if (state.userError) throw new Error(state.userError); }
          return (window as any).__secureHttp(args);
        }
        if (command === "secure_socket_open") {
          sockets.push(args);
          // Channel objects have their callback before the native invocation.
          queueMicrotask(() => args.events.onmessage({ type: "opened", id: args.id }));
          return;
        }
        if (command === "secure_socket_send") { state.input.push(args); return; }
        if (command === "clear_mobile_hub_url") { document.body.dataset.switched = "true"; return; }
        if (command === "set_mobile_hub_url") throw new Error("Encrypted pairing must stay bundled");
        if (command === "plugin:app|version") return "secure-test";
        return null;
      },
    } });
  }, { initial });
  await page.setViewportSize({ width: 390, height: 844 });
  const ordinary: string[] = [];
  page.on("request", request => { if (/\/api\/|\/ws\//.test(request.url())) ordinary.push(request.url()); });
  page.on("websocket", socket => ordinary.push(socket.url()));
  await page.goto("http://tauri.localhost/");
  return ordinary;
}

test("pairing stays on bundled assets and sends all Hub requests through native IPC", async ({ page }, testInfo) => {
  const ordinary = await bundledPhone(page);
  await expect(page.getByRole("button", { name: "Scan the code", exact: true })).toBeVisible();
  await page.getByPlaceholder("Hub address or offdesk://pair?…").fill("offdesk://pair?v=2&hub=https%3A%2F%2Fencrypted.example&key=pinned&code=code");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByTestId("mobile-workbench")).toBeVisible();
  expect(new URL(page.url()).origin).toBe("http://tauri.localhost");
  expect(ordinary).toEqual([]);
  const calls = await page.evaluate(() => (window as any).__secureTest.calls as string[]);
  expect(calls).toContain("secure_pair");
  expect(calls).toContain("secure_request");
  expect(calls).not.toContain("set_mobile_hub_url");
  await page.getByTestId("mobile-title-bar").click();
  await page.getByTestId("mobile-host-button").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByText("https://encrypted.example", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("End-to-end encrypted · https://encrypted.example")).toBeVisible();
  await page.getByText("End-to-end encrypted · https://encrypted.example").scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("encrypted-settings.png") });
  await page.getByRole("button", { name: "Switch hub", exact: true }).click();
  await expect(page.locator("body")).toHaveAttribute("data-switched", "true");
  expect(await page.evaluate(() => (window as any).__secureTest.calls.slice(-2))).toEqual(["secure_forget", "clear_mobile_hub_url"]);
  expect(await page.evaluate(() => localStorage.getItem("offdesk:token"))).toBeNull();
  expect(ordinary).toEqual([]);
});

test("an unreadable encrypted identity offers recovery without ordinary API traffic", async ({ page }) => {
  const ordinary = await bundledPhone(page, "damaged");
  await expect(page.getByText("Hub identity could not be verified")).toBeVisible();
  await expect(page.getByRole("button", { name: "Forget connection and pair again" })).toBeVisible();
  expect(ordinary).toEqual([]);
});

test("a saved remote route recovers an offline LAN connection without another QR", async ({ page }) => {
  const ordinary = await bundledPhone(page, "offline");
  const panel = page.getByTestId("connection-routes");
  const lan = panel.getByRole("button", { name: "Local network: http://192.168.1.2:4317", exact: true });
  const remote = panel.getByRole("button", { name: "Remote connection: https://encrypted.example", exact: true });
  await expect(lan).toBeDisabled();
  await expect(remote).toBeEnabled();
  await remote.click();
  await expect(page.getByTestId("mobile-workbench")).toBeVisible();
  const calls = await page.evaluate(() => (window as any).__secureTest.calls as string[]);
  expect(calls).toContain("secure_switch_route");
  expect(calls).not.toContain("secure_pair");
  expect(calls).not.toContain("secure_forget");
  expect(ordinary).toEqual([]);
});

test("connection selection verifies availability, preserves identity on failure and works on wide phones", async ({ page }, testInfo) => {
  const ordinary = await bundledPhone(page, "paired");
  await expect(page.getByTestId("mobile-workbench")).toBeVisible();
  await page.getByTestId("mobile-title-bar").click();
  await page.getByTestId("mobile-host-button").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const panel = page.getByTestId("connection-routes");
  const lan = panel.getByRole("button", { name: "Local network: http://192.168.1.2:4317", exact: true });
  await expect(lan).toBeEnabled();
  await page.evaluate(() => { (window as any).__secureTest.switchError = "Hub identity could not be verified"; });
  await lan.click();
  await expect(panel.getByRole("alert")).toContainText("Hub identity could not be verified");
  await expect(page.getByText("End-to-end encrypted · https://encrypted.example")).toBeVisible();
  await page.evaluate(() => { (window as any).__secureTest.switchError = ""; });
  await panel.getByRole("button", { name: "Check again" }).click();
  await expect(lan).toBeEnabled();
  await lan.click();
  await expect(page.getByText("End-to-end encrypted · http://192.168.1.2:4317")).toBeVisible();
  await expect(lan).toContainText("Current");
  await page.setViewportSize({ width: 750, height: 850 });
  await panel.scrollIntoViewIfNeeded();
  expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("connection-methods-wide.png") });
  await page.evaluate(() => { (window as any).__secureTest.routes.forEach((route: any) => { route.available = false; }); });
  await panel.getByRole("button", { name: "Check again" }).click();
  await expect(lan).toContainText("Unreachable");
  await expect(lan).toBeDisabled();
  await expect(panel.getByRole("button", { name: "Remote connection: https://encrypted.example", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => (window as any).__secureTest.calls.includes("secure_forget"))).toBe(false);
  expect(ordinary).toEqual([]);
});

for (const reason of ["Hub identity changed", "This device has been revoked", "Could not read device credentials"]) {
  test(`first paired account request offers recovery: ${reason}`, async ({ page }) => {
    const ordinary = await bundledPhone(page);
    await page.evaluate(reason => { (window as any).__secureTest.userError = reason; }, reason);
    await page.getByPlaceholder("Hub address or offdesk://pair?…").fill("offdesk://pair?v=2&hub=https%3A%2F%2Fencrypted.example&key=pinned&code=code");
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(page.getByText(reason, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Forget connection and pair again", exact: true })).toBeVisible();
    await page.clock.install();
    await page.clock.fastForward(10000);
    expect(await page.evaluate(() => (window as any).__secureTest.userRequests)).toBe(1);
    expect(ordinary).toEqual([]);
    if (reason === "Hub identity changed") {
      await page.getByRole("button", { name: "Try again", exact: true }).click();
      await expect(page.getByTestId("mobile-workbench")).toBeVisible();
    } else {
      await page.getByRole("button", { name: "Forget connection and pair again", exact: true }).click();
      await expect(page.locator("body")).toHaveAttribute("data-switched", "true");
      expect(await page.evaluate(() => localStorage.getItem("offdesk:token"))).toBeNull();
    }
    expect(ordinary).toEqual([]);
  });
}
