import { devices, expect, test, type Page, type Route } from "@playwright/test";
import { createTerminalViaApi, openApp, requestMachineControl, resetMachineState } from "./helpers";

// P01, P02 on iPhone, and P03, with the native side of the phone app
// modelled in the page the way the other mobile specs do.

// The boards are dark; the screenshots are for comparing with them.
test.use({ colorScheme: "dark" });

// P01 lives on the app's bundled setup screen. The bundled origin is
// localhost, so the hub's own build is served under that name.
async function bundledSetupScreen(page: Page, probe: { hub: string | null; expected: string } | "unreachable") {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("http://localhost:4317/**", async (route) => {
    const response = await route.fetch({ url: route.request().url().replace("http://localhost:4317", process.env.PLAYWRIGHT_BASE_URL ?? "http://hub:4317") });
    await route.fulfill({ response });
  });
  await page.addInitScript((probe) => {
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15" });
    const state = { scans: ["http://mac-mini.local:4317/?token=abc"], opened: [] as string[] };
    Object.assign(window, { __p01: state, __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1, unregisterCallback: () => {},
      invoke: async (command: string, args?: { url?: string; uri?: string }) => {
        if (command === "plugin:app|version") return "0.9.0";
        if (command.startsWith("plugin:barcode-scanner|") && /permissions/i.test(command)) return { camera: "granted" };
        if (command === "plugin:barcode-scanner|scan") return { content: state.scans.shift(), format: "QR_CODE" };
        if (command === "probe_hub_version") {
          if (probe === "unreachable") throw new Error("error sending request");
          return probe;
        }
        if (command === "set_mobile_hub_url") { state.opened.push(String(args?.url)); return args?.url; }
        if (command === "secure_hubs") return [];
        if (command === "secure_pairing_identity") return { hub_url: "http://mac-mini.local:4317", public_key: "pk-test" };
        return null;
      },
    } });
  }, probe);
  await page.goto("http://localhost:4317/login");
  await page.getByRole("button", { name: "Scan the code" }).click();
}

test("a browser code for an older hub explains before opening it (P01)", async ({ page }) => {
  await bundledSetupScreen(page, { hub: "0.21.4", expected: "0.23.0" });
  const notice = page.getByTestId("old-hub-notice");
  await expect(notice).toContainText("connect mac-mini.local");
  await expect(notice).toContainText("This hub is older than your app");
  await expect(notice).toContainText("this app0.9.0");
  await expect(notice).toContainText("mac-mini.local hub0.21.4");
  await expect(notice).toContainText("you would see0.21.4 interface");
  await page.screenshot({ path: "e2e/artifacts/p01-old-hub.png" });
  expect(await page.evaluate(() => (window as any).__p01.opened)).toEqual([]);
  // The browser code again is not what the screen asked for.
  await page.evaluate(() => { (window as any).__p01.scans.push("http://mac-mini.local:4317/?token=abc"); });
  await notice.getByRole("button", { name: "scan the encrypted code" }).click();
  await expect(notice.getByRole("alert")).toContainText("browser code again");
  await notice.getByRole("button", { name: "open the 0.21.4 interface anyway" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__p01.opened)).toEqual(["http://mac-mini.local:4317/?token=abc"]);
});

test("P01 has a way back, and another hub's code starts over", async ({ page }) => {
  await bundledSetupScreen(page, { hub: "0.21.4", expected: "0.23.0" });
  const notice = page.getByTestId("old-hub-notice");
  await expect(notice).toContainText("connect mac-mini.local");
  // A browser code for a different hub is asked about like any scan.
  await page.evaluate(() => { (window as any).__p01.scans.push("http://studio.local:4317/?token=def"); });
  await notice.getByRole("button", { name: "scan the encrypted code" }).click();
  await expect(notice).toContainText("connect studio.local");
  await expect(notice.getByRole("alert")).toHaveCount(0);
  await notice.getByRole("button", { name: "back", exact: true }).click();
  await expect(notice).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Scan the code" })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__p01.opened)).toEqual([]);
});

test("the encrypted code from P01 goes to encrypted pairing", async ({ page }) => {
  await bundledSetupScreen(page, { hub: null, expected: "0.23.0" });
  const notice = page.getByTestId("old-hub-notice");
  await expect(notice).toContainText("older than 0.23");
  await page.evaluate(() => { (window as any).__p01.scans.push("offdesk://pair?v=1&k=test"); });
  await notice.getByRole("button", { name: "scan the encrypted code" }).click();
  await expect(page.getByText("Confirm your Hub")).toBeVisible();
  expect(await page.evaluate(() => (window as any).__p01.opened)).toEqual([]);
});

test("a current hub opens exactly as before", async ({ page }) => {
  await bundledSetupScreen(page, { hub: "0.23.0", expected: "0.23.0" });
  await expect.poll(() => page.evaluate(() => (window as any).__p01.opened)).toEqual(["http://mac-mini.local:4317/?token=abc"]);
  await expect(page.getByTestId("old-hub-notice")).toHaveCount(0);
});

test("a hub that cannot be asked is opened as before", async ({ page }) => {
  await bundledSetupScreen(page, "unreachable");
  await expect.poll(() => page.evaluate(() => (window as any).__p01.opened)).toEqual(["http://mac-mini.local:4317/?token=abc"]);
  await expect(page.getByTestId("old-hub-notice")).toHaveCount(0);
});

async function iosBridge(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15" });
    const state = { opened: [] as string[] };
    Object.assign(window, { __iosUpdateTest: state, __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1, unregisterCallback: () => {},
      invoke: async (command: string, args?: { url?: string }) => {
        if (command === "plugin:app|version") return "0.8.0";
        if (command === "plugin:opener|open_url") { state.opened.push(String(args?.url)); return null; }
        return null;
      },
    } });
  });
  // The app reads offdesk.dev's copy of the listing and GitHub's at once;
  // both answer the same here, and `requests` counts GitHub's.
  let requests = 0;
  const listing = async (route: Route) => {
    if (route.request().url().startsWith("https://api.github.com/")) requests++;
    const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
    await route.fulfill({ json: [
      // Too fresh to be on TestFlight for everyone yet.
      { tag_name: "ios-v0.9.1", draft: false, prerelease: false, published_at: daysAgo(0.1) },
      { tag_name: "app-v0.9.1", draft: false, prerelease: false, published_at: daysAgo(2) },
      { tag_name: "ios-v0.9.0", draft: false, prerelease: false, published_at: daysAgo(2) },
      { tag_name: "ios-v0.8.0", draft: false, prerelease: false, published_at: daysAgo(9) },
    ] });
  };
  await page.route("https://api.github.com/repos/zalify/offdesk/releases**", listing);
  await page.route("https://offdesk.dev/updates/releases.json", listing);
  return () => requests;
}

test("iPhone offers a newer TestFlight build once a day", async ({ page }) => {
  const requests = await iosBridge(page);
  await page.goto("/login");
  const card = page.getByTestId("ios-update-toast");
  await expect(card).toContainText("Offdesk Dev 0.9.0", { timeout: 15000 });
  await expect(card).toContainText("you have 0.8.0");
  await card.getByRole("button", { name: "open TestFlight", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__iosUpdateTest.opened)).toEqual(["https://testflight.apple.com/join/rV4ktaGv"]);
  await card.getByRole("button", { name: "later", exact: true }).click();
  await expect(card).toHaveCount(0);
  // The next launch reads the day's answer from the cache and stays quiet.
  await page.reload();
  await page.waitForTimeout(6000);
  await expect(page.getByTestId("ios-update-toast")).toHaveCount(0);
  expect(requests()).toBe(1);
});

// A touch phone, in the browser every other test runs in.
const { defaultBrowserType: _browser, ...iPhone } = devices["iPhone 14"];

test.describe("on a touch phone", () => {
  test.use({ ...iPhone, colorScheme: "dark" });

  test("the app update card floats above the key bar (P02)", async ({ page }) => {
    await iosBridge(page);
    await openApp(page);
    await resetMachineState(page);
    await requestMachineControl(page);
    await createTerminalViaApi(page, { startupCommand: "sleep 600" });
    const keyBar = page.getByTestId("extended-keybar");
    await expect(keyBar).toBeVisible();
    const card = page.getByTestId("ios-update-toast");
    await expect(card).toBeVisible({ timeout: 15000 });
    await expect.poll(async () => {
      const [cardBox, barBox] = [await card.boundingBox(), await keyBar.boundingBox()];
      return cardBox && barBox ? barBox.y - (cardBox.y + cardBox.height) : -1;
    }).toBeGreaterThanOrEqual(8);
    await page.screenshot({ path: "e2e/artifacts/p02-update-card.png" });
  });
});

async function openMachinesSheet(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page);
  await page.getByTestId("mobile-title-bar-label").click();
  await page.getByTestId("mobile-host-button").click();
}

test("the phone's Machines sheet shows node versions and the update command", async ({ page }) => {
  // The e2e hub is plain http, like a hub at home: no clipboard API there.
  await page.addInitScript(() => {
    document.addEventListener("copy", () => { (window as any).__copied = document.getSelection()?.toString() || (document.activeElement as HTMLTextAreaElement | null)?.value; });
  });
  await page.route("**/api/version", (route) => route.fulfill({ json: { hub: "0.23.0", latest: "0.24.0", update_available: true } }));
  await page.route("**/api/machines/versions", (route) => route.fulfill({ json: [
    { id: "e2e-node", name: "e2e-machine", version: null, update_available: true },
  ] }));
  await openMachinesSheet(page);
  await expect(page.getByTestId("mobile-host-hub-version")).toHaveText(/^hub .+ · 0\.23\.0$/);
  const row = page.getByTestId("mobile-host-row-e2e-node");
  await expect(row.getByText("node older than 0.23")).toBeVisible();
  const chip = page.getByTestId("mobile-host-update-e2e-node");
  await expect(chip).toHaveText("↑ 0.24.0");
  // One line, however narrow the phone.
  expect((await chip.boundingBox())!.height).toBeLessThanOrEqual(24);
  const card = page.getByTestId("mobile-node-update-card");
  await expect(card).toContainText("updates happen on each Mac");
  await card.getByRole("button", { name: "copy update command" }).click();
  await expect(card.getByRole("button", { name: "copied" })).toBeVisible();
  await page.screenshot({ path: "e2e/artifacts/p03-machines.png" });
  expect(await page.evaluate(() => (window as any).__copied)).toBe("curl -fsSL https://offdesk.dev/install | sh -s -- --node-only");
});

test("a current node shows its version and no update prompt", async ({ page }) => {
  await page.route("**/api/version", (route) => route.fulfill({ json: { hub: "0.24.0", latest: "0.24.0", update_available: false } }));
  await page.route("**/api/machines/versions", (route) => route.fulfill({ json: [
    { id: "e2e-node", name: "e2e-machine", version: "0.24.0", update_available: false },
  ] }));
  await openMachinesSheet(page);
  await expect(page.getByTestId("mobile-host-row-e2e-node")).toContainText("· node 0.24.0");
  await expect(page.getByTestId("mobile-host-update-e2e-node")).toHaveCount(0);
  await expect(page.getByTestId("mobile-node-update-card")).toHaveCount(0);
});

test("a hub from before 0.23 gets the Machines sheet it always had", async ({ page }) => {
  await page.route("**/api/version", (route) => route.fulfill({ status: 404, body: "" }));
  await page.route("**/api/machines/versions", (route) => route.fulfill({ status: 405, body: "" }));
  await openMachinesSheet(page);
  await expect(page.getByRole("button", { name: "Add a machine" })).toBeVisible();
  await expect(page.getByTestId("mobile-host-row-e2e-node")).toBeVisible();
  await expect(page.getByTestId("mobile-host-hub-version")).toHaveCount(0);
  await expect(page.getByTestId("mobile-host-row-e2e-node")).not.toContainText("node ");
  await expect(page.getByTestId("mobile-node-update-card")).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
});
