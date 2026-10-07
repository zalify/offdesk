import { test, expect, devices, type Page } from "@playwright/test";
import {
  createTerminalViaApi,
  mobileTakeControl,
  openApp,
  readTerminalBuffer,
  resetMachineState,
} from "./helpers";
import { readDownload } from "./fetch-files.helpers";

test.use({ ...devices["iPhone 14"], browserName: "chromium" });

const SETUP =
  "rm -rf /tmp/e2e-fbm; mkdir -p /tmp/e2e-fbm/sub; " +
  "printf 'file browser body\\n' > /tmp/e2e-fbm/report.txt; ";

const row = (page: Page, name: string) =>
  page.locator(`[data-testid="file-browser-row"][data-name="${name}"]`);
const browser = (page: Page) => page.getByTestId("file-browser");

test.describe("file browser on the phone", () => {
  test("title-bar button opens the surface, tap a folder and a file", async ({ page }) => {
    await openApp(page);
    await resetMachineState(page);
    await mobileTakeControl(page);
    const id = await createTerminalViaApi(page, {
      cwd: "/tmp",
      startupCommand: `${SETUP}printf 'FB_READY\\n'; sleep 600`,
    });
    await expect.poll(() => readTerminalBuffer(page, id)).toContain("FB_READY");

    await page.getByTestId("mobile-title-bar-files").click();
    await expect(page.getByTestId("mobile-file-browser-surface")).toBeVisible();
    await expect(browser(page)).toHaveAttribute("data-path", "/tmp");

    await row(page, "e2e-fbm").tap();
    await expect(browser(page)).toHaveAttribute("data-path", "/tmp/e2e-fbm");
    const box = await row(page, "report.txt").boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);

    const download = page.waitForEvent("download", { timeout: 15_000 });
    await row(page, "report.txt").tap();
    const file = await download;
    expect(file.suggestedFilename()).toBe("report.txt");
    expect(await readDownload(file)).toBe("file browser body\n");

    await page.getByTestId("mobile-file-browser-surface-back").tap();
    await expect(page.getByTestId("mobile-file-browser-surface")).toHaveCount(0);
  });

  test("at 320px the title bar has no Files button; the machines sheet opens it", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await openApp(page);
    await resetMachineState(page);
    await mobileTakeControl(page);
    const id = await createTerminalViaApi(page, {
      cwd: "/tmp",
      startupCommand: `${SETUP}printf 'FB_READY\\n'; sleep 600`,
    });
    await expect.poll(() => readTerminalBuffer(page, id)).toContain("FB_READY");

    await expect(page.getByTestId("mobile-title-bar-files")).toHaveCount(0);
    await page.getByRole("button", { name: "Open Machines and Hub menu", exact: true }).tap();
    await page.getByTestId("mobile-menu-files").tap();
    await expect(page.getByTestId("mobile-file-browser-surface")).toBeVisible();
    await expect(browser(page)).toHaveAttribute("data-path", "/tmp");
  });
});
