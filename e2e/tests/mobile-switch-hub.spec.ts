import { expect, test, type Page } from "@playwright/test";
import { openApp } from "./helpers";

// Model the iOS 0.4.12 bridge. WKWebView can silently cancel window.confirm;
// switching hubs must work without that browser dialog.
async function mobileBridge(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15" });
    const state = { calls: 0, confirms: 0, fail: false, hold: false, release: () => {} };
    Object.assign(window, { __mobileTest: state });
    window.confirm = () => { state.confirms++; return false; };
    Object.assign(window, {
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        transformCallback: () => 1,
        unregisterCallback: () => {},
        invoke: async (command: string) => {
          if (command === "plugin:app|version") return "0.4.12";
          if (command !== "clear_mobile_hub_url") return null;
          state.calls++;
          if (state.hold) await new Promise<void>(resolve => { state.release = resolve; });
          if (state.fail) throw new Error("Could not open the setup screen.");
          // The real native command clears its store and navigates to bundled
          // setup. Here navigation marks a successful handoff to that command.
          window.location.assign("/login?switched=1");
        },
      },
    });
  });
  await openApp(page);
  await page.getByTestId("mobile-title-bar").click();
  await page.getByTestId("mobile-host-button").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByText("Shell version: 0.4.12")).toBeVisible();
}

test("mobile Switch hub works when browser confirmation is unavailable", async ({ page }) => {
  await mobileBridge(page);
  const dialogs: string[] = [];
  page.on("dialog", async dialog => { dialogs.push(dialog.type()); await dialog.dismiss(); });
  await page.getByRole("button", { name: "Switch hub", exact: true }).click();
  await expect(page).toHaveURL(/\/login\?switched=1/);
  expect(dialogs).toEqual([]);
});

test("mobile Switch hub reports native errors and allows one retry at a time", async ({ page }) => {
  await mobileBridge(page);
  await page.evaluate(() => { (window as any).__mobileTest.fail = true; });
  await page.getByRole("button", { name: "Switch hub", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Could not switch hubs. Could not open the setup screen.");
  await expect(page.getByRole("button", { name: "Switch hub", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => (window as any).__mobileTest.confirms)).toBe(0);
  await page.evaluate(() => { Object.assign((window as any).__mobileTest, { fail: false, hold: true }); });
  await page.getByRole("button", { name: "Switch hub", exact: true }).click();
  await expect(page.getByRole("button", { name: "Switching…", exact: true })).toBeDisabled();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__mobileTest.calls)).toBe(2);
  await page.evaluate(() => { (window as any).__mobileTest.release(); });
  await expect(page).toHaveURL(/\/login\?switched=1/);
});
