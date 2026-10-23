import { test, expect, type Page } from "@playwright/test";
import {
  createTerminalViaApi,
  expandTerminalById,
  getAuthHeaders,
  mobileTakeControl,
  openApp,
  readTerminalBuffer,
  requestMachineControl,
  resetMachineState,
} from "./helpers";
import { locate, readDownload } from "./fetch-files.helpers";

// A small tree under /tmp/e2e-fb, rebuilt on every run:
//   report.txt  note.md  .hidden-file  sub/deep.txt  big.bin (21 MiB)
const SETUP =
  "rm -rf /tmp/e2e-fb; mkdir -p /tmp/e2e-fb/sub; " +
  "printf 'file browser body\\n' > /tmp/e2e-fb/report.txt; " +
  "printf '# Title\\n\\n**bold**\\n' > /tmp/e2e-fb/note.md; " +
  "printf 'secret\\n' > /tmp/e2e-fb/.hidden-file; " +
  "printf 'deep body\\n' > /tmp/e2e-fb/sub/deep.txt; " +
  "head -c 22020096 /dev/zero > /tmp/e2e-fb/big.bin; ";

const row = (page: Page, name: string) =>
  page.locator(`[data-testid="file-browser-row"][data-name="${name}"]`);
const browser = (page: Page) => page.getByTestId("file-browser");

async function startTerminal(page: Page, extra = "") {
  const id = await createTerminalViaApi(page, {
    cwd: "/tmp",
    startupCommand: `${SETUP}${extra}printf 'FB_READY\\n'; sleep 600`,
  });
  return id;
}

test.describe("file browser on desktop", () => {
  test("browse, filter, toggle hidden files and download", async ({ page }) => {
    await openApp(page);
    await resetMachineState(page);
    await requestMachineControl(page);
    const id = await startTerminal(page);
    await expandTerminalById(page, id);
    await expect.poll(() => readTerminalBuffer(page, id)).toContain("FB_READY");

    await page.getByTestId("tab-bar-files").click();
    await expect(page.getByTestId("file-browser-overlay")).toBeVisible();
    // Starts at the terminal's cwd.
    await expect(browser(page)).toHaveAttribute("data-path", "/tmp");

    // Into a directory through the list.
    await row(page, "e2e-fb").click();
    await expect(browser(page)).toHaveAttribute("data-path", "/tmp/e2e-fb");
    await expect(row(page, "sub")).toBeVisible();
    // Directories sort before files.
    const kinds = await page
      .getByTestId("file-browser-row")
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-kind")));
    expect(kinds.indexOf("file")).toBeGreaterThan(kinds.lastIndexOf("dir"));

    // Hidden files.
    await expect(row(page, ".hidden-file")).toHaveCount(0);
    await page.getByTestId("file-browser-hidden").check();
    await expect(row(page, ".hidden-file")).toBeVisible();
    await page.getByTestId("file-browser-hidden").uncheck();
    await expect(row(page, ".hidden-file")).toHaveCount(0);

    // Files over 20 MB are disabled.
    await expect(row(page, "big.bin")).toBeDisabled();
    await expect(row(page, "big.bin")).toContainText("over 20 MB");

    // Filter.
    await page.getByTestId("file-browser-filter").fill("REPO");
    await expect(page.getByTestId("file-browser-row")).toHaveCount(1);
    await expect(row(page, "report.txt")).toBeVisible();
    await page.getByTestId("file-browser-filter").fill("");

    // Clicking a file previews it; download comes from the preview.
    await row(page, "report.txt").click();
    await expect(page.getByTestId("file-browser-preview")).toHaveAttribute("data-kind", "text");
    await expect(page.getByTestId("file-browser-preview-text")).toContainText("file browser body");
    const download = page.waitForEvent("download", { timeout: 15_000 });
    await page.getByTestId("file-browser-preview-download").click();
    const file = await download;
    expect(file.suggestedFilename()).toBe("report.txt");
    expect(await readDownload(file)).toBe("file browser body\n");

    // Back returns to the listing in the same directory.
    await page.getByTestId("file-browser-preview-back").click();
    await expect(page.getByTestId("file-browser-preview")).toHaveCount(0);
    await expect(browser(page)).toHaveAttribute("data-path", "/tmp/e2e-fb");

    // Markdown renders inside an iframe with an empty sandbox.
    await row(page, "note.md").click();
    const rich = page.getByTestId("file-browser-preview-rich");
    await expect(rich).toHaveAttribute("sandbox", "");
    await expect(page.getByTestId("file-browser-preview")).toHaveAttribute("data-kind", "markdown");
    const frame = page.frameLocator('[data-testid="file-browser-preview-rich"]');
    await expect(frame.locator("h1")).toHaveText("Title");
    await expect(frame.locator("strong")).toHaveText("bold");
    // Escape closes the preview only, not the whole overlay.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("file-browser-preview")).toHaveCount(0);
    await expect(page.getByTestId("file-browser-overlay")).toBeVisible();

    // Down into sub, then back out through the breadcrumb.
    await row(page, "sub").click();
    await expect(browser(page)).toHaveAttribute("data-path", "/tmp/e2e-fb/sub");
    await expect(row(page, "deep.txt")).toBeVisible();
    await page
      .locator('[data-testid="file-browser-crumb"][data-path="/tmp/e2e-fb"]')
      .click();
    await expect(browser(page)).toHaveAttribute("data-path", "/tmp/e2e-fb");
    await expect(row(page, "report.txt")).toBeVisible();

    // Up button, then Esc closes.
    await page.getByTestId("file-browser-up").click();
    await expect(browser(page)).toHaveAttribute("data-path", "/tmp");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("file-browser-overlay")).toHaveCount(0);
  });

  test("keyboard navigation", async ({ page }) => {
    await openApp(page);
    await resetMachineState(page);
    await requestMachineControl(page);
    const id = await startTerminal(page);
    await expandTerminalById(page, id);
    await expect.poll(() => readTerminalBuffer(page, id)).toContain("FB_READY");

    await page.getByTestId("tab-bar-files").click();
    await expect(browser(page)).toHaveAttribute("data-path", "/tmp");
    // Typing filters; Enter opens the first match.
    await expect(row(page, "e2e-fb")).toBeVisible();
    await page.keyboard.type("e2e-fb");
    await expect(page.getByTestId("file-browser-filter")).toHaveValue("e2e-fb");
    await page.keyboard.press("Enter");
    await expect(browser(page)).toHaveAttribute("data-path", "/tmp/e2e-fb");
    // "sub" is the first row (directories first).
    await expect(row(page, "sub")).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(browser(page)).toHaveAttribute("data-path", "/tmp/e2e-fb/sub");
    await expect(row(page, "deep.txt")).toBeVisible();
    await page.keyboard.press("Alt+ArrowUp");
    await expect(browser(page)).toHaveAttribute("data-path", "/tmp/e2e-fb");
    await expect(row(page, "report.txt")).toBeVisible();
    await page.keyboard.press("Backspace");
    await expect(browser(page)).toHaveAttribute("data-path", "/tmp");
  });

  test("shows an error with retry when the directory disappears", async ({ page }) => {
    await openApp(page);
    await resetMachineState(page);
    await requestMachineControl(page);
    // The directory is removed a few seconds in, while the browser sits in it.
    const id = await startTerminal(
      page,
      "mkdir -p /tmp/e2e-fb-gone; (sleep 6; rm -rf /tmp/e2e-fb-gone) & ",
    );
    await expandTerminalById(page, id);
    await expect.poll(() => readTerminalBuffer(page, id)).toContain("FB_READY");
    await page.getByTestId("tab-bar-files").click();
    await row(page, "e2e-fb-gone").click();
    await expect(browser(page)).toHaveAttribute("data-path", "/tmp/e2e-fb-gone");
    await expect(page.getByTestId("file-browser-empty")).toBeVisible();
    await expect(async () => {
      await page.getByTestId("file-browser-refresh").click();
      await expect(page.getByTestId("file-browser-error")).toContainText("Folder not found", {
        timeout: 1_000,
      });
    }).toPass({ timeout: 20_000 });
    await expect(page.getByTestId("file-browser-retry")).toBeVisible();
    // Back up through the breadcrumb recovers.
    await page.locator('[data-testid="file-browser-crumb"][data-path="/tmp"]').click();
    await expect(row(page, "e2e-fb")).toBeVisible();
  });

  test("edit a text file, and refuse to save over a newer change", async ({ page }) => {
    await openApp(page);
    await resetMachineState(page);
    await requestMachineControl(page);
    const id = await startTerminal(page, "printf 'A=1\\nB=2\\n' > /tmp/e2e-fb/app.env; ");
    await expandTerminalById(page, id);
    await expect.poll(() => readTerminalBuffer(page, id)).toContain("FB_READY");
    const headers = await getAuthHeaders(page);
    const readOnMachine = async () => {
      const resp = await page.request.get(
        "/api/machines/e2e-node/fs/read?path=/tmp/e2e-fb/app.env",
        { headers },
      );
      const file = (await resp.json()) as { data_base64: string; sha256: string };
      return { text: Buffer.from(file.data_base64, "base64").toString("utf8"), sha256: file.sha256 };
    };

    await page.getByTestId("tab-bar-files").click();
    await row(page, "e2e-fb").click();
    await row(page, "app.env").click();
    await expect(page.getByTestId("file-browser-preview-text")).toContainText("A=1");

    // Edit and save: the machine has the new text.
    await page.getByTestId("file-browser-preview-edit").click();
    const editor = page.getByTestId("file-browser-editor");
    await expect(editor).toHaveValue("A=1\nB=2\n");
    await editor.fill("A=2\nB=2\n");
    // Backspace and Escape stay in the editor: Esc asks before dropping changes.
    await editor.press("End");
    await editor.press("Backspace");
    await editor.press("Escape");
    await expect(page.getByTestId("file-browser-overlay")).toBeVisible();
    await expect(page.getByTestId("file-browser-editor-discard")).toBeVisible();
    await page.getByTestId("file-browser-editor-keep").click();
    await editor.fill("A=2\nB=2\n");
    await page.getByTestId("file-browser-editor-save").click();
    await expect(editor).toHaveCount(0);
    await expect(page.getByTestId("file-browser-preview-text")).toContainText("A=2");
    await expect.poll(async () => (await readOnMachine()).text).toBe("A=2\nB=2\n");

    // The file changes on the machine while it is open in the editor.
    await page.getByTestId("file-browser-preview-edit").click();
    await editor.fill("A=3\nB=2\n");
    const before = await readOnMachine();
    const resp = await page.request.put("/api/machines/e2e-node/fs/write", {
      headers,
      data: {
        path: "/tmp/e2e-fb/app.env",
        data_base64: Buffer.from("A=machine\n").toString("base64"),
        base_sha256: before.sha256,
      },
    });
    expect(resp.ok()).toBeTruthy();
    await page.getByTestId("file-browser-editor-save").click();
    await expect(page.getByTestId("file-browser-editor-error")).toContainText("changed on the machine");
    expect((await readOnMachine()).text).toBe("A=machine\n");
    // Closing is refused while the edit is unsaved; reloading drops it.
    await page.getByTestId("file-browser-overlay-close").click();
    await expect(page.getByTestId("file-browser-overlay")).toBeVisible();
    await page.getByTestId("file-browser-editor-reload").click();
    await expect(page.getByTestId("file-browser-preview-text")).toContainText("A=machine");
  });

  test("a directory path in the terminal opens the browser there", async ({ page }) => {
    await openApp(page);
    await resetMachineState(page);
    await requestMachineControl(page);
    const id = await startTerminal(page, "printf 'dir: /tmp/e2e-fb/sub ok\\n'; ");
    await expandTerminalById(page, id);
    await expect.poll(() => readTerminalBuffer(page, id)).toContain("dir: /tmp/e2e-fb/sub");

    const { x, y } = await locate(page, "/tmp/e2e-fb/sub");
    await page.mouse.move(x - 4, y);
    await page.mouse.move(x, y);
    await page.mouse.click(x, y);
    await expect(page.getByTestId("file-browser-overlay")).toBeVisible();
    await expect(browser(page)).toHaveAttribute("data-path", "/tmp/e2e-fb/sub");
    await expect(row(page, "deep.txt")).toBeVisible();
  });
});
