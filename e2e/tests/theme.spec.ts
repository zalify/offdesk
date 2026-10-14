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

type ThemeName = "Graphite" | "Midnight" | "Slate" | "Ember" | "Paper" | "Sepia" | "Sage";

async function chooseTheme(page: Page, name: ThemeName) {
  const button = page.getByRole("group", { name: "Theme", exact: true })
    .getByRole("button", { name: `${name} theme`, exact: true });
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
}

async function followSystem(page: Page) {
  const toggle = page.getByRole("switch", { name: "Follow the system" });
  if (await toggle.getAttribute("aria-checked") !== "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
}

// The live xterm's colours, read from the instance the app exposes for tests.
async function terminalColors(page: Page, id: string) {
  return page.evaluate((terminalId) => {
    const terminals = (window as unknown as { __offdeskTerminals?: Map<string, {
      options: { theme?: { background?: string }; minimumContrastRatio?: number };
    }> }).__offdeskTerminals;
    const term = terminals?.get(terminalId);
    return { background: term?.options.theme?.background, minimumContrast: term?.options.minimumContrastRatio };
  }, id);
}

test("theme choice persists and follows system changes only when selected", async ({ page, context }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await openApp(page);
  // With no choice saved the app follows the system: Graphite or Paper.
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "graphite");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "paper");
  await page.emulateMedia({ colorScheme: "dark" });
  await openSettings(page);
  await chooseTheme(page, "Graphite");
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(25, 25, 23)");
  await chooseTheme(page, "Sepia");
  await expect(page.locator("html")).toHaveCSS("color-scheme", "light");
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(241, 231, 208)");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "sepia");
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(241, 231, 208)");
  await openSettings(page);
  await expect(page.getByRole("button", { name: "Sepia theme", exact: true })).toHaveAttribute("aria-pressed", "true");

  // Changing another tab updates the mounted app without resetting it.
  const other = await context.newPage();
  await openApp(other);
  await openSettings(other);
  await chooseTheme(other, "Ember");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "ember");
  await other.close();

  // Following the system switches between a chosen pair.
  await followSystem(page);
  await page.getByRole("combobox", { name: "when light" }).selectOption("sage");
  await page.getByRole("combobox", { name: "when dark" }).selectOption("slate");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "slate");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "sage");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "sage");
  await openSettings(page);
  // Picking a theme stops following the system.
  await chooseTheme(page, "Midnight");
  await expect(page.getByRole("switch", { name: "Follow the system" })).toHaveAttribute("aria-checked", "false");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "midnight");
});

test("an old light or dark choice opens in Paper or Graphite", async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("seeded")) {
      localStorage.setItem("offdesk:theme", "dark");
      localStorage.removeItem("offdesk:theme-css");
      sessionStorage.setItem("seeded", "1");
    }
  });
  await page.emulateMedia({ colorScheme: "light" });
  await openApp(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "graphite");
});

test("the terminal recolours with the theme without reconnecting", async ({ page }) => {
  await openApp(page);
  await resetMachineState(page);
  await requestMachineControl(page);
  const id = await createTerminalViaApi(page, { cwd: "/tmp", startupCommand: "printf 'colour check\\n'; sleep 600" });
  await expandTerminalById(page, id);
  await expect.poll(() => terminalColors(page, id)).toEqual(expect.objectContaining({ background: expect.any(String) }));
  await openSettings(page);
  await chooseTheme(page, "Sepia");
  await page.getByTitle("Back", { exact: true }).click();
  await expect.poll(() => terminalColors(page, id)).toEqual({ background: "#f4ead3", minimumContrast: 3 });
  await openSettings(page);
  await chooseTheme(page, "Slate");
  await page.getByTitle("Back", { exact: true }).click();
  await expect.poll(() => terminalColors(page, id)).toEqual({ background: "#2b303a", minimumContrast: 1 });
});

test("the phone's appearance sheet tries themes on the terminal and cancel puts them back", async ({ browser }, testInfo) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await page.emulateMedia({ colorScheme: "dark" });
  await openApp(page);
  await resetMachineState(page);
  await mobileTakeControl(page);
  const id = await createTerminalViaApi(page, { cwd: "/tmp", startupCommand: "printf 'appearance\\n'; sleep 600" });
  await expandTerminalById(page, id);
  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-theme", "graphite");

  await mobileOpenHostSheet(page);
  await page.getByTestId("mobile-menu-appearance").click();
  const sheet = page.getByTestId("appearance-sheet");
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "Ember theme", exact: true }).click();
  await expect(html).toHaveAttribute("data-theme", "ember");
  await expect.poll(() => terminalColors(page, id)).toEqual({ background: "#1c1814", minimumContrast: 1 });
  await expect(sheet.getByTestId("appearance-done")).toHaveText("use ember");
  await page.screenshot({ path: testInfo.outputPath("appearance-ember.png") });
  await sheet.getByTestId("appearance-tab-font").click();
  await sheet.getByRole("button", { name: "Larger terminal text" }).click();
  await expect(sheet.getByTestId("appearance-font-size")).toHaveText("15px");
  await sheet.getByTestId("appearance-cancel").click();
  await expect(sheet).toHaveCount(0);
  await expect(html).toHaveAttribute("data-theme", "graphite");
  expect(await page.evaluate(() => localStorage.getItem("offdesk:terminal-font-size"))).toBeNull();

  await mobileOpenHostSheet(page);
  await page.getByTestId("mobile-menu-appearance").click();
  await sheet.getByRole("button", { name: "Sage theme", exact: true }).click();
  await sheet.getByTestId("appearance-done").click();
  await expect(sheet).toHaveCount(0);
  await page.reload();
  await expect(html).toHaveAttribute("data-theme", "sage");
  await page.screenshot({ path: testInfo.outputPath("appearance-sage.png") });
  await context.close();
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

    for (const name of ["Paper", "Graphite", "Sepia"] as const) {
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
