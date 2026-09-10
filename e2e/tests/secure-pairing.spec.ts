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
    let status = JSON.parse(sessionStorage.getItem("test:status") || "null") ?? { endpoint: { hub_url: "https://encrypted.example", public_key: "pinned" }, device_id: "phone" };
    const routes = [
      { kind: "local", hub_url: "http://192.168.1.2:4317", available: initial !== "offline" },
      { kind: "remote", hub_url: "https://encrypted.example", available: true },
    ];
    if (initial === "offline") status.endpoint.hub_url = routes[0].hub_url;
    const other = { endpoint: { hub_url: "https://office.example", public_key: "office-pinned" }, device_id: "office-phone" };
    const storedHubs = [{ name: "Home Hub", status: { ...status, endpoint: { hub_url: "https://encrypted.example", public_key: "pinned" } } }, { name: "Office Hub", status: other }];
    const firstPairError = sessionStorage.getItem("test:first-pair-error"); sessionStorage.removeItem("test:first-pair-error");
    const sockets: { id: string; events: any }[] = [];
    const state = { routes, switchError: "", configured: (initial === "paired" || initial === "offline") || sessionStorage.getItem("test:paired") === "true", damaged: initial === "damaged", userError: firstPairError ?? (initial === "offline" ? "Local network is unreachable" : ""), userRequests: 0, calls: JSON.parse(sessionStorage.getItem("test:calls") || "[]") as string[], input: [] as unknown[] };
    Object.assign(window, { __secureTest: state });
    Object.assign(window, { __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1,
      unregisterCallback: () => {},
      invoke: async (command: string, args: any) => {
        state.calls.push(command);
        sessionStorage.setItem("test:calls", JSON.stringify(state.calls));
        if (command === "secure_hubs") return state.configured ? structuredClone(storedHubs) : [];
        if (command === "secure_pairing_identity") return { hub_url: "https://encrypted.example", public_key: "pinned" };
        if (command === "secure_switch_hub") {
          if (state.switchError) throw new Error(state.switchError);
          const target = storedHubs.find(hub => hub.status.endpoint.public_key === args.publicKey);
          if (!target) throw new Error("Unknown Hub");
          status = structuredClone(target.status); status.endpoint.hub_url = args.url;
          sessionStorage.setItem("test:status", JSON.stringify(status)); state.userError = "";
          return structuredClone(status);
        }
        if (command === "secure_status") { if (state.damaged) throw new Error("Hub identity could not be verified"); return state.configured ? structuredClone(status) : null; }
        if (command === "secure_routes") {
          if (state.damaged) throw new Error("Cannot read saved connection routes");
          const target = args?.publicKey === "office-pinned" ? other : status;
          return structuredClone({ status: target, routes: args?.publicKey === "office-pinned" ? [{ kind: "local", hub_url: "http://192.168.3.2:4317", available: false }, { kind: "remote", hub_url: other.endpoint.hub_url, available: true }] : state.routes, discovery_available: true, machines: [{ name: "Mac Mini", os: "macos" }] });
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
          state.configured = true; sessionStorage.setItem("test:paired", "true");
          sessionStorage.setItem("test:status", JSON.stringify(status));
          if (state.userError) sessionStorage.setItem("test:first-pair-error", state.userError);
          return structuredClone(status);
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
  await expect(page.getByText("Confirm your Hub", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Pair and connect", exact: true }).click();
  await expect(page.getByTestId("mobile-workbench")).toBeVisible();
  expect(new URL(page.url()).origin).toBe("http://tauri.localhost");
  expect(ordinary).toEqual([]);
  const calls = await page.evaluate(() => (window as any).__secureTest.calls as string[]);
  expect(calls).toContain("secure_pair");
  expect(calls).toContain("secure_request");
  expect(calls).not.toContain("set_mobile_hub_url");
  await page.getByTestId("mobile-title-bar-badge").click();
  await page.getByTestId("mobile-host-button").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByTestId("hub-picker").getByRole("button", { name: /Home Hub/ })).toContainText("Current Hub");
  await expect(page.getByText("End-to-end encrypted · https://encrypted.example")).toBeVisible();
  await page.getByText("End-to-end encrypted · https://encrypted.example").scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("encrypted-settings.png") });
  await expect(page.getByTestId("hub-picker")).toBeVisible();
  await page.getByRole("button", { name: /Office Hub/ }).click();
  await expect(page.getByRole("button", { name: /192.168.3.2/ })).toBeDisabled();
  expect(await page.evaluate(() => (window as any).__secureTest.calls.includes("secure_forget"))).toBe(false);
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

test("compact Hub menu checks availability and keeps the source Hub on failure", async ({ page }, testInfo) => {
  const ordinary = await bundledPhone(page, "paired");
  await expect(page.getByTestId("mobile-workbench")).toBeVisible();
  await page.setViewportSize({ width: 320, height: 740 });
  await expect(page.getByTestId("mobile-title-bar")).toHaveCSS("height", "44px");
  await page.getByRole("button", { name: "Open Machines and Hub menu" }).click();
  await page.getByRole("button", { name: "Hub & connection", exact: true }).click();
  const panel = page.getByTestId("hub-picker");
  await panel.getByRole("button", { name: /Office Hub/ }).click();
  await expect(panel.getByRole("button", { name: /192.168.3.2/ })).toBeDisabled();
  await expect(panel.getByText("Mac Mini · macos")).toBeVisible();
  await page.evaluate(() => { (window as any).__secureTest.switchError = "Hub identity could not be verified"; });
  await panel.getByRole("button", { name: /office.example/ }).click();
  await expect(panel.getByRole("alert")).toContainText("current Hub is still selected");
  await expect(panel.getByRole("button", { name: /office.example/ })).toBeEnabled();
  await panel.getByRole("button", { name: "Saved Hubs", exact: true }).click();
  await expect(panel.getByRole("button", { name: /Home Hub/ })).toContainText("Current Hub");
  expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("hub-picker-320.png") });
  await page.getByRole("button", { name: "Back to Machines" }).click();
  await expect(panel).toHaveCount(0);
  await page.getByRole("button", { name: "Hub & connection", exact: true }).click();
  await page.evaluate(() => { (window as any).__secureTest.switchError = ""; });
  await panel.getByRole("button", { name: /Office Hub/ }).click();
  await panel.getByRole("button", { name: /office.example/ }).click();
  await expect(page.getByTestId("mobile-workbench")).toBeVisible();
  await page.getByRole("button", { name: "Open Machines and Hub menu" }).click();
  await page.getByRole("button", { name: "Hub & connection", exact: true }).click();
  await expect(page.getByRole("button", { name: /Office Hub/ })).toContainText("Current Hub");
  expect(await page.evaluate(() => (window as any).__secureTest.calls.includes("secure_forget"))).toBe(false);
  expect(ordinary).toEqual([]);
});

test("adding a Hub asks for identity confirmation and can be cancelled without losing existing pairings", async ({ page }) => {
  await bundledPhone(page, "paired");
  await page.getByRole("button", { name: "Open Machines and Hub menu" }).click();
  await page.getByRole("button", { name: "Hub & connection", exact: true }).click();
  const panel = page.getByTestId("hub-picker");
  await panel.getByRole("button", { name: "Add a Hub", exact: true }).click();
  await panel.getByPlaceholder("offdesk://pair?…").fill("offdesk://pair?v=2&hub=https%3A%2F%2Fencrypted.example&key=pinned&code=code");
  await panel.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(panel.getByText("Confirm your Hub", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__secureTest.calls.includes("secure_pair"))).toBe(false);
  await panel.getByRole("button", { name: "Saved Hubs", exact: true }).click();
  await expect(panel.getByRole("button", { name: /Home Hub/ })).toContainText("Current Hub");
  expect(await page.evaluate(() => (window as any).__secureTest.calls.includes("secure_forget"))).toBe(false);
});

for (const reason of ["Hub identity changed", "This device has been revoked", "Could not read device credentials"]) {
  test(`first paired account request offers recovery: ${reason}`, async ({ page }) => {
    const ordinary = await bundledPhone(page);
    await page.evaluate(reason => { (window as any).__secureTest.userError = reason; }, reason);
    await page.getByPlaceholder("Hub address or offdesk://pair?…").fill("offdesk://pair?v=2&hub=https%3A%2F%2Fencrypted.example&key=pinned&code=code");
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(page.getByText("Confirm your Hub", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Pair and connect", exact: true }).click();
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
