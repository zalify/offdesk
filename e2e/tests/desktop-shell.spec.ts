import { expect, test, type Page, type Locator, webkit } from "@playwright/test";
import { createTerminalViaApi, expandTerminalById, requestMachineControl, resetMachineState, openApp, pressPrefixKey } from "./helpers";

// Exercise the bundled desktop route with a fake native bridge. Real hub
// requests still go through the E2E hub; no native services are installed.
async function desktopBridge(page: Page, role: "client" | "hub" | null = "client") {
  await page.addInitScript((initialRole) => {
    let role = initialRole;
    let callbackId = 0;
    const callbacks = new Map<number, (data: unknown) => void>();
    const state = { installed: true, setup: { hub_running: true, machine_registered: true, node_online: true, tmux_available: true }, installError: "", holdInstall: false, finishInstall: (() => {}) as () => void, updater: "current", calls: [] as string[], listening: true, linkFailures: 0, linkRequests: [] as string[], pairError: "", pairDelay: 0, pairCompleted: 0, qrOverflow: false, secureUrl: null as string | null, cloudState: { state: "unregistered", local_enabled: false, verified: false } as Record<string, unknown>, cloudError: "", cloudActions: [] as string[], cloudApproved: false };
    Object.assign(window, { __desktopTest: state });
    Object.assign(window, {
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        transformCallback: (callback: (data: unknown) => void) => {
          callbacks.set(++callbackId, callback);
          return callbackId;
        },
        unregisterCallback: (id: number) => callbacks.delete(id),
        invoke: async (command: string, args?: { role?: "client" | "hub"; handler?: number; baseUrl?: string; action?: string }) => {
          state.calls.push(command);
          if (command === "cloud_action") {
            const action = args?.action ?? "status"; state.cloudActions.push(action);
            if (state.cloudError) throw new Error(state.cloudError);
            const url = "https://0123456789abcdef0123456789abcdef.cloud.offdesk.dev";
            if (action === "login") return { id: "hub", state: "pending", user_code: "ABCDEF123456", verification_uri: "https://cloud.offdesk.dev/connect?code=ABCDEF123456", expires_at: Math.floor(Date.now()/1000)+600 };
            if (action === "login-status") {
              if (state.cloudApproved) { state.cloudState = { state: "active", url, local_enabled: false, verified: false }; return { id: "hub", state: "approved" }; }
              return { id: "hub", state: "pending" };
            }
            if (action === "enable") state.cloudState = { state: "active", url, local_enabled: true, verified: false };
            if (action === "check") state.cloudState = { state: "active", url, local_enabled: true, verified: true };
            if (action === "disable") state.cloudState = { state: "revoking", url, local_enabled: false, verified: false };
            return state.cloudState;
          }
          if (command === "secure_status") return null;
          if (command === "desktop_role") return role;
          if (command === "hub_status") return { supported: true, bundled: true, hub_installed: state.installed, node_installed: state.installed, listening: state.listening, setup: state.setup };
          if (command === "hub_pair") {
            const hub_url = args?.baseUrl ?? "https://hub.example.com:8443";
            const error = state.pairError;
            if (state.pairDelay) await new Promise(resolve => setTimeout(resolve, state.pairDelay));
            state.pairCompleted++;
            if (error) throw new Error(error);
            return { pairing_uri: "offdesk://pair?v=2&hub=" + encodeURIComponent(hub_url) + "&key=" + "A".repeat(43) + "&code=" + "B".repeat(43), hub_url, expires_at: Date.now() + 300000, connection_check: { identity_verified: true, handshake_ms: 850, legacy_routes_hidden: false } };
          }
          if (command === "hub_install") {
            if (state.holdInstall) await new Promise<void>(resolve => { state.finishInstall = resolve; });
            if (state.installError) throw new Error(state.installError);
            return { url: "http://192.168.1.10:4317", link: "http://192.168.1.10:4317/?token=test-token", short: null, candidates: [] };
          }
          if (command === "hub_link") {
            if (state.linkFailures > 0) { state.linkFailures--; throw new Error("Hub restarting"); }
            const publicUrl = "https://hub.example.com:8443";
            const url = args?.baseUrl || publicUrl;
            state.linkRequests.push(url);
            return { url, secure_url: state.secureUrl, public_url: publicUrl, local_url: "http://127.0.0.1:4317", link: url + "/?token=test-token", short: state.qrOverflow ? "X".repeat(5000) : url + "/?code=TESTCODE", candidates: [{ interface: "en0", address: "192.168.1.10" }] };
          }
          if (command === "set_desktop_role") { role = args?.role ?? "client"; return; }
          if (command === "plugin:app|version") return "0.5.3-test";
          if (command === "plugin:updater|check") {
            if (state.updater === "error") throw new Error("Update server unavailable");
            if (state.updater === "available") return { rid: 7, currentVersion: "0.5.3", version: "0.5.4", rawJson: {} };
            return null;
          }
          if (command === "plugin:event|listen") return args?.handler ?? 1;
          if (command === "plugin:window|is_maximized") return false;
          return undefined;
        },
      },
    });
  }, role);
}

test("desktop settings, theme, update recovery and menus work in a small window", async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 800, height: 600 });
  await desktopBridge(page);
  await openApp(page);
  await resetMachineState(page);
  await requestMachineControl(page);
  const terminalId = await createTerminalViaApi(page, { cwd: "/tmp", startupCommand: "printf 'Desktop audit\\n'; sleep 600" });
  await expandTerminalById(page, terminalId);
  await expect(page.getByTestId("tab-bar-new-group")).toBeInViewport();
  await expect(page.getByTestId("app-title-bar")).toHaveCount(1);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  await expect(page.getByText("Shell version: 0.5.3-test")).toBeVisible();
  const updates = page.getByTestId("desktop-update-settings");
  await page.evaluate(() => { (window as any).__desktopTest.updater = "error"; });
  await updates.getByRole("button", { name: "Check for updates" }).click();
  await expect(updates.getByRole("alert")).toContainText("Update server unavailable");
  await page.evaluate(() => { (window as any).__desktopTest.updater = "current"; });
  await updates.getByRole("button", { name: "Check for updates" }).click();
  await expect(updates.getByRole("status")).toHaveText("You’re up to date.");
  await page.evaluate(() => { (window as any).__desktopTest.updater = "available"; });
  await updates.getByRole("button", { name: "Check for updates" }).click();
  await expect(updates.getByRole("button", { name: "Install update" })).toBeEnabled();
  // If another installation already picked up the update, don't get stuck.
  await page.evaluate(() => { (window as any).__desktopTest.updater = "current"; });
  await updates.getByRole("button", { name: "Install update" }).click();
  await expect(updates.getByRole("status")).toHaveText("You’re up to date.");
  await expect(updates.getByRole("button", { name: "Check for updates" })).toBeEnabled();

  await page.getByRole("textbox", { name: "Server URL" }).fill("not a hub");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("valid http:// or https://");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("offdesk:token"))).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath("desktop-settings-dark.png") });
  await page.getByTitle("Back", { exact: true }).click();
  await pressPrefixKey(page, "k");
  await expect(page.getByTestId("command-palette")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+,");
  await expect(page.getByRole("group", { name: "Theme", exact: true })).toBeVisible();
  await page.getByTitle("Back", { exact: true }).click();
  await page.getByTestId("desktop-workspace-manager-button").click();
  await expect(page.getByTestId("workspace-manager")).toBeVisible();
  await page.getByTestId("workspace-manager-close").click();
  await page.getByTestId("tab-bar-phone").click();
  await expect(page.getByTestId("phone-dialog")).toBeVisible();
  await expect(page.getByRole("link", { name: "iPhone · TestFlight" })).toHaveAttribute("href", "https://testflight.apple.com/join/rV4ktaGv");
  await page.screenshot({ path: testInfo.outputPath("desktop-phone-dark.png") });
  await page.getByTestId("phone-dialog").getByRole("button", { name: "Close", exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath("desktop-workbench-dark.png") });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.reload();
  await expect(page.getByTestId("tab-bar")).toBeVisible();
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await page.getByTitle("Back", { exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath("desktop-workbench-light.png") });
  expect(pageErrors).toEqual([]);
});

test("changing the desktop hub drops the previous hub login", async ({ page }) => {
  await desktopBridge(page);
  const response = await page.request.get("/api/auth/dev");
  expect(response.ok()).toBeTruthy();
  const { token } = await response.json();
  await page.addInitScript((token) => {
    if (!sessionStorage.getItem("desktop-auth-seeded")) {
      localStorage.setItem("offdesk:token", token);
      sessionStorage.setItem("desktop-auth-seeded", "1");
    }
  }, token);
  await page.route("https://other-hub.example/**", (route) => route.fulfill({ status: 200, json: {} }));
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("textbox", { name: "Server URL" }).fill("https://other-hub.example");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("offdesk:server_url"))).toBe("https://other-hub.example");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("offdesk:token"))).toBeNull();
});

test("desktop startup keeps window controls and content reachable", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await desktopBridge(page, null);
  await page.addInitScript(() => Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36" }));
  await page.goto("/");
  await expect(page.getByTestId("first-run-client")).toBeVisible();
  await expect(page.getByTestId("app-title-bar")).toHaveCount(1);
  // The CI browser's Linux UA exercises the custom non-macOS controls.
  await page.getByRole("button", { name: "Minimize", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__desktopTest.calls)).toContain("plugin:window|minimize");
  await page.getByTestId("first-run-client").scrollIntoViewIfNeeded();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("desktop-first-run.png") });
});


test("hub phone dialog offers tunnel and LAN QR codes without covering the desktop", async ({ page }, testInfo) => {
  await desktopBridge(page, "hub");
  await page.setViewportSize({ width: 800, height: 600 });
  await openApp(page);
  await page.evaluate(() => { (window as any).__desktopTest.linkFailures = 1; });
  await page.getByTestId("tab-bar-phone").click();
  await expect(page.getByText("Waiting for the hub to reconnect…")).toBeVisible();
  const dialog = page.getByTestId("phone-dialog");
  const picker = dialog.getByTestId("hub-address-picker");
  await expect(dialog.getByTestId("phone-purpose-app")).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.getByLabel("Phone sign-in QR code", { exact: true })).toHaveCount(0);
  await dialog.getByTestId("phone-purpose-browser").click();
  await expect(picker).toHaveValue("https://hub.example.com:8443");
  await expectPaintedQr(dialog.getByRole("img", { name: "Phone sign-in QR code", exact: true }));
  await expect(page.getByTestId("hub-ready-open")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__desktopTest.calls)).not.toContain("hub_install");
  await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeInViewport();
  await picker.selectOption("http://192.168.1.10:4317");
  await expect(picker).toHaveValue("http://192.168.1.10:4317");
  await picker.selectOption("https://hub.example.com:8443");
  await expect(picker).toHaveValue("https://hub.example.com:8443");
  await expect.poll(() => page.evaluate(() => (window as any).__desktopTest.linkRequests.slice(-2))).toEqual([
    "http://192.168.1.10:4317", "https://hub.example.com:8443",
  ]);
  await dialog.getByTestId("phone-purpose-app").click();
  await expect(dialog.getByLabel("Phone sign-in QR code", { exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Pair an encrypted device", exact: true }).click();
  await expectPaintedQr(dialog.getByRole("img", { name: "Encrypted device pairing QR code", exact: true }));
  await expect.poll(async () => {
    const box = await dialog.getByLabel("Encrypted device pairing QR code").boundingBox();
    return box !== null && box.y >= 20 && box.y + box.height <= 580;
  }).toBe(true);
  await expect(dialog.getByTestId("secure-pairing-panel").getByRole("status")).toContainText("Hub verified · 850 ms handshake from this Mac");
  await expect(dialog.getByRole("button", { name: "Copy pairing link", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("desktop-encrypted-pairing.png") });
  await picker.selectOption("http://192.168.1.10:4317");
  await expect(dialog.getByLabel("Encrypted device pairing QR code")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("desktop-hub-phone-tunnel.png") });
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("tab-bar")).toBeVisible();
});

test("encrypted pairing reports failures and discards a slow check after the address changes", async ({ page }) => {
  await desktopBridge(page, "hub");
  await page.setViewportSize({ width: 800, height: 600 });
  await openApp(page);
  await page.getByTestId("tab-bar-phone").click();
  const dialog = page.getByTestId("phone-dialog");
  const panel = dialog.getByTestId("secure-pairing-panel");
  const picker = dialog.getByTestId("hub-address-picker");
  await expect(picker).toHaveValue("https://hub.example.com:8443");
  await page.evaluate(() => { (window as any).__desktopTest.pairError = "This address could not be verified as this Hub."; });
  await panel.getByRole("button", { name: "Pair an encrypted device", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("could not be verified");
  await expect(panel.getByLabel("Encrypted device pairing QR code")).toHaveCount(0);
  await page.evaluate(() => {
    (window as any).__desktopTest.pairError = "";
    (window as any).__desktopTest.pairDelay = 3000;
  });
  await panel.getByRole("button", { name: "Pair an encrypted device", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Checking connection…", exact: true })).toBeDisabled();
  await picker.selectOption("http://192.168.1.10:4317");
  await page.evaluate(() => { (window as any).__desktopTest.pairDelay = 0; });
  await expect(panel.getByRole("alert")).toHaveCount(0);
  await panel.getByRole("button", { name: "Pair an encrypted device", exact: true }).click();
  await expect(panel.getByText("http://192.168.1.10:4317", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__desktopTest.pairCompleted)).toBe(3);
  await expect(panel.getByText("https://hub.example.com:8443", { exact: true })).toHaveCount(0);
  await expect(panel.getByText("http://192.168.1.10:4317", { exact: true })).toBeVisible();
  await expect(panel.getByLabel("Encrypted device pairing QR code")).toBeVisible();
});

test("desktop startup recovers after a hub restart without losing login", async ({ page }) => {
  await desktopBridge(page, "hub");
  await openApp(page);
  const token = await page.evaluate(() => localStorage.getItem("offdesk:token"));
  let unavailable = true;
  await page.route("**/api/auth/me", route => unavailable
    ? route.fulfill({ status: 503, body: "Hub restarting" }) : route.continue());
  await page.addInitScript(() => { (window as any).__desktopTest.listening = false; });
  await page.reload();
  await expect(page.getByRole("status")).toContainText("Reconnecting to your hub");
  await page.waitForTimeout(2500);
  expect(await page.evaluate(() => localStorage.getItem("offdesk:token"))).toBe(token);
  await expect(page.getByText("Running. Now get your phone in.")).toHaveCount(0);
  unavailable = false;
  await page.evaluate(() => { (window as any).__desktopTest.listening = true; });
  await expect(page.getByTestId("tab-bar")).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("offdesk:token"))).toBe(token);
});

test("an unauthorized session is still cleared", async ({ page }) => {
  await desktopBridge(page);
  await openApp(page);
  await page.route("**/api/auth/me", route => route.fulfill({ status: 401, body: "Unauthorized" }));
  await page.reload();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("offdesk:token"))).toBeNull();
});


test("managed Cloud is used only for encrypted pairing while browser links retain their address", async ({ page }) => {
  await desktopBridge(page, "hub");
  await openApp(page);
  const cloud = "https://0123456789abcdef0123456789abcdef.cloud.offdesk.dev";
  await page.evaluate((url) => { (window as any).__desktopTest.secureUrl = url; }, cloud);
  await page.getByTestId("tab-bar-phone").click();
  const dialog = page.getByTestId("phone-dialog");
  const picker = dialog.getByTestId("hub-address-picker");
  const panel = dialog.getByTestId("secure-pairing-panel");
  await expect(picker).toHaveCount(0);
  await expect(panel.getByText("Offdesk Cloud · " + cloud, { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Pair an encrypted device", exact: true }).click();
  await expect(panel.getByText(cloud, { exact: true })).toBeVisible();
  await dialog.getByTestId("phone-purpose-browser").click();
  await expect(panel).toHaveCount(0);
  await picker.selectOption("http://192.168.1.10:4317");
  await expect(picker).toHaveValue("http://192.168.1.10:4317");
  await expectPaintedQr(dialog.getByLabel("Phone sign-in QR code", { exact: true }));
  await dialog.getByTestId("phone-purpose-app").click();
  await expect(picker).toHaveCount(0);
  await panel.getByRole("button", { name: "Pair an encrypted device", exact: true }).click();
  await expect(panel.getByText(cloud, { exact: true })).toBeVisible();
  await expect(panel.getByLabel("Encrypted device pairing QR code")).toBeVisible();
});


test("Cloud sign-in, automatic verification, pairing and disabling work without terminal commands", async ({ page }) => {
  await desktopBridge(page, "hub");
  await page.setViewportSize({ width: 900, height: 800 });
  await openApp(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const panel = page.getByTestId("cloud-connection-panel");
  await panel.getByRole("button", { name: "Sign in with GitHub", exact: true }).click();
  await expect(panel.getByText("ABCDEF123456", { exact: true })).toBeVisible();
  await page.evaluate(() => { (window as any).__desktopTest.cloudApproved = true; });
  await expect(panel.getByText("Remote connection ready · Encryption verified")).toBeVisible({ timeout: 15000 });
  await expect(panel.getByRole("button", { name: "Enable remote connection", exact: true })).toHaveCount(0);
  await page.evaluate(() => { (window as any).__desktopTest.secureUrl = "https://0123456789abcdef0123456789abcdef.cloud.offdesk.dev"; });
  await panel.getByRole("button", { name: "Connect your phone", exact: true }).click();
  await page.getByRole("button", { name: "Pair an encrypted device", exact: true }).click();
  await expect(page.getByLabel("Encrypted device pairing QR code")).toHaveCount(1);
  await panel.getByRole("button", { name: "Turn off remote access", exact: true }).click();
  await panel.getByRole("button", { name: "Keep connected", exact: true }).click();
  expect(await page.evaluate(() => (window as any).__desktopTest.cloudActions)).not.toContain("disable");
  await panel.getByRole("button", { name: "Turn off remote access", exact: true }).click();
  await panel.getByRole("button", { name: "Turn off", exact: true }).click();
  await expect(panel.getByText("Remote access is being removed. Check again to confirm it has finished.")).toBeVisible();
  await expect(page.getByLabel("Encrypted device pairing QR code")).toHaveCount(0);
});


test("Cloud status stops claiming readiness after outage and recovers on refresh", async ({ page }) => {
  await desktopBridge(page, "hub");
  await page.clock.install();
  await openApp(page);
  await page.evaluate(() => {
    (window as any).__desktopTest.cloudState = { state: "active", local_enabled: true, verified: true,
      url: "https://0123456789abcdef0123456789abcdef.cloud.offdesk.dev" };
  });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const panel = page.getByTestId("cloud-connection-panel");
  const ready = panel.getByText("Remote connection ready · Encryption verified");
  await expect(ready).toBeVisible();
  await page.evaluate(() => { (window as any).__desktopTest.cloudState.verified = false; });
  await panel.getByRole("button", { name: "Check again", exact: true }).click();
  await expect(ready).toHaveCount(0);
  await expect(panel.getByText("Remote connection is not verified. Keep this Mac online; Offdesk retries automatically.")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Connect your phone", exact: true })).toHaveCount(0);
  // Failure to fetch status must also invalidate the old success.
  await page.evaluate(() => { (window as any).__desktopTest.cloudState.verified = true; });
  await panel.getByRole("button", { name: "Check again", exact: true }).click();
  await expect(ready).toBeVisible();
  await page.evaluate(() => { (window as any).__desktopTest.cloudError = "Network unavailable"; });
  await page.clock.fastForward(31000);
  await expect(ready).toHaveCount(0);
  await expect(panel.getByRole("alert")).toHaveText("Network unavailable");
  await page.evaluate(() => { (window as any).__desktopTest.cloudError = ""; });
  await page.clock.fastForward(31000);
  await expect(ready).toBeVisible();
  await expect(panel.getByRole("alert")).toHaveCount(0);
});

// Checking a wrapper's visibility did not prove that its SVG painted. Exercise
// real image decoding and pixels in both Chromium and the desktop's WebKit engine.
async function expectPaintedQr(image: Locator) {
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((node: HTMLImageElement) => {
    if (!node.complete || !node.naturalWidth) return false;
    const box = node.getBoundingClientRect();
    if (box.width < 100 || Math.abs(box.width - box.height) > 1) return false;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 200;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(node, 0, 0, 200, 200);
    const pixels = ctx.getImageData(0, 0, 200, 200).data;
    let dark = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 100 && pixels[i + 3] > 200) dark++;
    return dark > 3000 && dark < 25000;
  })).toBe(true);
}

test("WebKit paints ordinary and encrypted phone QR images at compact and wide sizes", async ({ baseURL }) => {
  const browser = await webkit.launch();
  try {
    const context = await browser.newContext({ baseURL });
    const page = await context.newPage();
    await desktopBridge(page, "hub");
    await openApp(page);
    await page.getByTestId("tab-bar-phone").click();
    const dialog = page.getByTestId("phone-dialog");
    await dialog.getByTestId("phone-purpose-browser").click();
    for (const width of [800, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await expectPaintedQr(dialog.getByRole("img", { name: "Phone sign-in QR code", exact: true }));
    }
    await dialog.getByTestId("phone-purpose-app").click();
    await dialog.getByRole("button", { name: "Pair an encrypted device", exact: true }).click();
    await expectPaintedQr(dialog.getByRole("img", { name: "Encrypted device pairing QR code", exact: true }));
  } finally { await browser.close(); }
});


test("phone QR generation failure keeps the full-link fallback and recovers on an address change", async ({ page }) => {
  await desktopBridge(page, "hub");
  await openApp(page);
  await page.getByTestId("tab-bar-phone").click();
  const dialog = page.getByTestId("phone-dialog");
  await dialog.getByTestId("phone-purpose-browser").click();
  await expectPaintedQr(dialog.getByRole("img", { name: "Phone sign-in QR code", exact: true }));
  await page.evaluate(() => { (window as any).__desktopTest.qrOverflow = true; });
  await dialog.getByTestId("hub-address-picker").selectOption("http://192.168.1.10:4317");
  await expect(dialog.getByRole("alert")).toContainText("Use Copy link below instead");
  await expect(dialog.getByRole("button", { name: "Copy link", exact: true })).toBeEnabled();
  await expect(dialog.getByRole("img", { name: "Phone sign-in QR code", exact: true })).toHaveCount(0);
  await page.evaluate(() => { (window as any).__desktopTest.qrOverflow = false; });
  await dialog.getByTestId("hub-address-picker").selectOption("https://hub.example.com:8443");
  await expectPaintedQr(dialog.getByRole("img", { name: "Phone sign-in QR code", exact: true }));
});


test("first-run does not expose the phone QR while installation is still running", async ({ page }) => {
  await desktopBridge(page, null);
  await page.goto("/");
  await expect(page.getByTestId("first-run-hub")).toBeVisible();
  await page.evaluate(() => {
    const state = (window as any).__desktopTest;
    state.installed = false;
    state.setup.node_online = false;
    state.holdInstall = true;
  });
  await page.getByTestId("first-run-hub").click();
  await expect(page.getByText("Getting this Mac ready…", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__desktopTest.calls.filter((c: string) => c === "hub_install").length)).toBe(1);
  // Reproduce launchd becoming ready before the install command has returned.
  await page.evaluate(() => {
    const state = (window as any).__desktopTest;
    state.installed = true;
    state.setup.node_online = true;
  });
  await page.waitForTimeout(2500);
  await expect(page.getByTestId("hub-ready-open")).toHaveCount(0);
  await expect(page.getByText("Getting this Mac ready…", { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).__desktopTest.finishInstall());
  await expect(page.getByTestId("hub-ready-open")).toBeVisible();
});

test("first-run failure stays actionable and retries without manual terminal commands", async ({ page }) => {
  await desktopBridge(page, null);
  await page.goto("/");
  await expect(page.getByTestId("first-run-hub")).toBeVisible();
  await page.evaluate(() => {
    const state = (window as any).__desktopTest;
    state.installed = false;
    state.setup.machine_registered = false;
    state.installError = "Could not register this Mac";
  });
  await page.getByTestId("first-run-hub").click();
  await expect(page.getByText(/Could not register this Mac/)).toBeVisible();
  await expect(page.getByTestId("hub-ready-open")).toHaveCount(0);
  await page.evaluate(() => {
    const state = (window as any).__desktopTest;
    state.installError = "";
    state.installed = true;
    state.setup.machine_registered = true;
  });
  await page.getByTestId("hub-setup-retry").click();
  await expect(page.getByTestId("hub-ready-open")).toBeVisible();
});


test("desktop connection setup has a visible way back before any form fields", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await desktopBridge(page, null);
  await page.goto("/");
  await page.getByTestId("first-run-client").click();
  await expect(page.getByTestId("login-back-to-setup")).toBeInViewport();
  await expect(page.getByTestId("login-become-hub")).toBeInViewport();
  await page.getByTestId("login-back-to-setup").click();
  await expect(page.getByTestId("first-run-hub")).toBeVisible();
  expect(await page.evaluate(() => (window as any).__desktopTest.calls)).not.toContain("hub_install");
});

test("settings centers desktop content and keeps the scrollbar at the window edge", async ({ page }, testInfo) => {
  await desktopBridge(page, "hub");
  await openApp(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  for (const width of [1440, 800, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const scroller = page.getByTestId("settings-content");
    const column = page.getByTestId("settings-column");
    const outer = (await scroller.boundingBox())!;
    const inner = (await column.boundingBox())!;
    expect(outer.width).toBeGreaterThan(width - 30);
    expect(Math.abs(inner.x + inner.width / 2 - (outer.x + outer.width / 2))).toBeLessThan(12);
    expect(inner.width).toBeLessThanOrEqual(880);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`settings-${width}.png`) });
  }
});
