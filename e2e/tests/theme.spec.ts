import { expect, test, type Page } from "@playwright/test";
import {
  createTerminalViaApi,
  expandTerminalById,
  mobileOpenHostSheet,
  mobileTakeControl,
  openApp,
  requestMachineControl,
  resetMachineState,
} from "./helpers";

async function openSettings(page: Page) {
  await expect(page.locator('[data-testid="tab-bar"], [data-testid="mobile-workbench"]')).toBeVisible();
  const mobile = await page.getByTestId("mobile-workbench").isVisible();
  if (mobile) {
    await mobileOpenHostSheet(page);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
  } else {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
  }
  await expect(page.getByRole("group", { name: "Theme", exact: true })).toBeVisible();
}

async function chooseTheme(page: Page, name: "Light" | "Dark" | "System") {
  const button = page.getByRole("group", { name: "Theme", exact: true })
    .getByRole("button", { name, exact: true });
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
}

test("theme choice persists and follows system changes only when selected", async ({ page, context }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await openApp(page);
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await openSettings(page);
  await chooseTheme(page, "Dark");
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(23, 20, 32)");
  await page.reload();
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  await openSettings(page);
  await expect(page.getByRole("button", { name: "Dark", exact: true })).toHaveAttribute("aria-pressed", "true");

  // Changing another tab updates the mounted app without resetting it.
  const other = await context.newPage();
  await openApp(other);
  await openSettings(other);
  await chooseTheme(other, "Light");
  await expect(page.locator("html")).toHaveCSS("color-scheme", "light");
  await other.close();

  await chooseTheme(page, "System");
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveCSS("color-scheme", "light");
  await chooseTheme(page, "Dark");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
});

for (const width of [390, 1024]) {
  test(`touch selection stays readable in both themes at ${width}px`, async ({ browser }, testInfo) => {
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: true });
    const page = await context.newPage();
    await openApp(page);
    await resetMachineState(page);
    const mobile = await page.getByTestId("mobile-workbench").isVisible();
    if (mobile) await mobileTakeControl(page);
    else await requestMachineControl(page);
    const marker = "Task complete. 已完成本轮任务，可以查看结果。";
    const terminalId = await createTerminalViaApi(page, {
      cwd: "/tmp", cols: 80, rows: 24,
      startupCommand: `printf '${marker}\\n'; sleep 600`,
    });
    await expandTerminalById(page, terminalId);

    for (const name of ["Light", "Dark"] as const) {
      await openSettings(page);
      await chooseTheme(page, name);
      await page.screenshot({ path: testInfo.outputPath(`settings-${name}.png`) });
      await page.getByTitle("Back", { exact: true }).click();
      // Settings temporarily unmounts the terminal; wait for its repaint
      // before capturing the selection overlay's fixed snapshot.
      await expect.poll(() => page.evaluate((id) => {
        const terminals = (window as unknown as { __offdeskTerminals?: Map<string, {
          buffer: { active: { length: number; getLine: (row: number) => { translateToString: (trim: boolean) => string } | undefined } };
        }> }).__offdeskTerminals;
        const buffer = terminals?.get(id)?.buffer.active;
        return buffer ? Array.from({ length: buffer.length }, (_, row) => buffer.getLine(row)?.translateToString(true) ?? "").join("\n") : "";
      }, terminalId)).toContain(marker);
      await page.getByTestId("extended-keybar-select-toggle").click();
      const overlay = page.getByTestId("terminal-select-overlay");
      await expect(overlay).toContainText(marker);
      const selected = await overlay.evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        const style = getComputedStyle(el, "::selection");
        return { color: style.color, background: style.backgroundColor };
      });
      expect(contrast(selected.color, selected.background)).toBeGreaterThanOrEqual(4.5);
      await page.screenshot({ path: testInfo.outputPath(`selection-${name}.png`) });
      await page.getByTestId("extended-keybar-select-done").click();
      await expect(overlay).toHaveCount(0);
    }
    await context.close();
  });
}

function contrast(foreground: string, background: string) {
  const luminance = (color: string) => {
    const channels = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map((c) => {
      const value = c / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const a = luminance(foreground), b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
