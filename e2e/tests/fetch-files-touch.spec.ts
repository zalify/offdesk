import { test, expect, devices, type Page } from "@playwright/test";
import { createTerminalViaApi, mobileTakeControl, openApp, readTerminalBuffer, resetMachineState } from "./helpers";
import { locate, readDownload } from "./fetch-files.helpers";

test.use({ ...devices["iPhone 14"], browserName: "chromium" });

// WebView taps produce no mouse events, so links activate from touchend.
const tap = async (page: Page, needle: string) => {
  const { x, y } = await locate(page, needle);
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: string) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: type === "touchEnd" ? [] : [{ x, y, radiusX: 12, radiusY: 12, force: 1, id: 1 }],
    });
  const download = page.waitForEvent("download", { timeout: 15_000 });
  await touch("touchStart");
  await page.waitForTimeout(60);
  await touch("touchEnd");
  return download;
};

for (const [name, command, needle, filename, body] of [
  [
    "a bare path",
    `printf 'tap two\\n' > /tmp/e2e-tap-bare.txt; printf 'out: /tmp/e2e-tap-bare.txt\\n'; sleep 600`,
    "/tmp/e2e-tap-bare.txt",
    "e2e-tap-bare.txt",
    "tap two\n",
  ],
] as const) {
  test(`tapping ${name} downloads the file`, async ({ page }) => {
    await openApp(page);
    await resetMachineState(page);
    await mobileTakeControl(page);
    const id = await createTerminalViaApi(page, { cwd: "/tmp", startupCommand: command });
    await expect.poll(() => readTerminalBuffer(page, id)).toContain(needle);
    const download = await tap(page, needle);
    expect(download.suggestedFilename()).toBe(filename);
    expect(await readDownload(download)).toBe(body);
  });
}
