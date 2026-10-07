import { test, expect, type Page } from "@playwright/test";
import {
  createTerminalViaApi,
  mobileTakeControl,
  expandTerminalById,
  openApp,
  readTerminalBuffer,
  requestMachineControl,
  resetMachineState,
} from "./helpers";
import { locate, readDownload } from "./fetch-files.helpers";

async function clickAndDownload(page: Page, needle: string) {
  const { x, y } = await locate(page, needle);
  // xterm's Linkifier needs a hover before it will activate on click.
  await page.mouse.move(x - 4, y);
  await page.mouse.move(x, y);
  const download = page.waitForEvent("download", { timeout: 15_000 });
  await page.mouse.click(x, y);
  return download;
}

test("clicking a bare absolute path downloads the file", async ({ page }) => {
  await openApp(page);
  await resetMachineState(page);
  await requestMachineControl(page);
  const id = await createTerminalViaApi(page, {
    cwd: "/tmp",
    startupCommand:
      `printf 'bare contents\\n' > /tmp/e2e-fetch-bare.txt; ` +
      `printf 'wrote /tmp/e2e-fetch-bare.txt:12:3 ok\\n'; sleep 600`,
  });
  await expandTerminalById(page, id);
  await expect.poll(() => readTerminalBuffer(page, id)).toContain("wrote /tmp/e2e-fetch-bare.txt");

  const download = await clickAndDownload(page, "/tmp/e2e-fetch-bare.txt");
  expect(download.suggestedFilename()).toBe("e2e-fetch-bare.txt");
  expect(await readDownload(download)).toBe("bare contents\n");
});

test("clicking a ./relative path resolves against the terminal cwd", async ({ page }) => {
  await openApp(page);
  await resetMachineState(page);
  await requestMachineControl(page);
  const id = await createTerminalViaApi(page, {
    cwd: "/tmp",
    startupCommand:
      `printf 'rel contents\\n' > /tmp/e2e-fetch-rel.txt; ` +
      `printf 'see ./e2e-fetch-rel.txt now\\n'; sleep 600`,
  });
  await expandTerminalById(page, id);
  await expect.poll(() => readTerminalBuffer(page, id)).toContain("see ./e2e-fetch-rel.txt");

  const download = await clickAndDownload(page, "./e2e-fetch-rel.txt");
  expect(download.suggestedFilename()).toBe("e2e-fetch-rel.txt");
  expect(await readDownload(download)).toBe("rel contents\n");
});

test("a missing file shows an error notice instead of downloading", async ({ page }) => {
  await openApp(page);
  await resetMachineState(page);
  await requestMachineControl(page);
  const id = await createTerminalViaApi(page, {
    cwd: "/tmp",
    startupCommand: `printf 'gone /tmp/e2e-no/such-file.txt\\n'; sleep 600`,
  });
  await expandTerminalById(page, id);
  await expect.poll(() => readTerminalBuffer(page, id)).toContain("gone /tmp/e2e-no");
  const { x, y } = await locate(page, "/tmp/e2e-no/such-file.txt");
  await page.mouse.move(x - 4, y);
  await page.mouse.move(x, y);
  await page.mouse.click(x, y);
  await expect(page.getByTestId("offdesk-notice")).toContainText("找不到 such-file.txt");
});

test("clicking an OSC 8 file link downloads the file", async ({ page }) => {
  await openApp(page);
  await resetMachineState(page);
  await requestMachineControl(page);
  const id = await createTerminalViaApi(page, {
    cwd: "/tmp",
    startupCommand:
      `printf '中文内容\\n' > '/tmp/e2e osc 文件.txt'; ` +
      `printf '\\033]8;;file://h/tmp/e2e%%20osc%%20文件.txt\\033\\\\OSC_LINK\\033]8;;\\033\\\\\\n'; sleep 600`,
  });
  await expandTerminalById(page, id);
  await expect.poll(() => readTerminalBuffer(page, id)).toContain("OSC_LINK");

  const download = await clickAndDownload(page, "OSC_LINK");
  expect(download.suggestedFilename()).toBe("e2e osc 文件.txt");
  expect(await readDownload(download)).toBe("中文内容\n");
});
