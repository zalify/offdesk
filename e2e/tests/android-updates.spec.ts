import { expect, test, type Page } from "@playwright/test";
import { openApp } from "./helpers";

async function androidBridge(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36" });
    const state = { checks: 0, installs: 0, fail: false, version: "0.7.0" as string | null };
    Object.assign(window, { __androidUpdateTest: state, __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1, unregisterCallback: () => {},
      invoke: async (command: string) => {
        if (command === "plugin:app|version") return "0.6.2";
        if (command === "plugin:offdesk-android-updater|check") {
          state.checks++;
          if (state.fail) throw new Error("Network unavailable");
          return { version: state.version, currentVersion: "0.6.2" };
        }
        if (command === "plugin:offdesk-android-updater|install") {
          state.installs++;
          return { status: state.installs === 1 ? "permission-required" : "installer-opened" };
        }
        return null;
      },
    } });
  });
}

test("Android checks for updates before login and supports permission retry", async ({ page }) => {
  await androidBridge(page);
  await page.goto("/login");
  const toast = page.getByTestId("android-update-toast");
  await expect(toast).toContainText("Offdesk 0.7.0 is available", { timeout: 15000 });
  await toast.getByRole("button", { name: "Install update" }).click();
  await expect(toast).toContainText("Allow Offdesk to install apps");
  await toast.getByRole("button", { name: "Install update" }).click();
  await expect(toast).toContainText("Finish the update in the Android installer");
  await toast.getByRole("button", { name: "Later" }).click();
  await expect(toast).toHaveCount(0);
});

test("Android settings exposes manual checks and reports network failure", async ({ page }) => {
  await androidBridge(page);
  await openApp(page);
  await page.getByTestId("mobile-title-bar").click();
  await page.getByTestId("mobile-host-button").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("android-update-settings");
  await expect(settings).toBeVisible();
  await page.evaluate(() => { (window as any).__androidUpdateTest.version = null; });
  await settings.getByRole("button", { name: "Check for updates" }).click();
  await expect(settings).toContainText("You’re up to date.");
  await page.evaluate(() => { (window as any).__androidUpdateTest.fail = true; });
  await settings.getByRole("button", { name: "Check for updates" }).click();
  await expect(settings.getByRole("alert")).toContainText("Network unavailable");
});

test("browser users are not offered the Android updater", async ({ page }) => {
  await openApp(page);
  await expect(page.getByTestId("android-update-toast")).toHaveCount(0);
  await expect(page.getByTestId("android-update-settings")).toHaveCount(0);
});
