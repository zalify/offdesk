import { devices, expect, test, type Page } from "@playwright/test";
import type { Terminal } from "@xterm/xterm";
import { mobileOpenHostSheet, openApp } from "./helpers";

async function mockTerminal(page: Page) {
  await page.route("**/api/bootstrap", route => route.fulfill({ json: {
    snapshot_seq: 1, last_focused_terminal_id: "font-test",
    machines: [{ id: "e2e-node", name: "Test host", os: "linux", home_dir: "/tmp" }],
    terminals: [{ id: "font-test", machine_id: "e2e-node", title: "Font test", cwd: "/tmp", cols: 80, rows: 24, reachable: true }],
    workspace_groups: [], workspace_layouts: [], machine_stats: [], control_leases: [],
  } }));
  await page.routeWebSocket(/\/ws\/events/, () => {});
  await page.routeWebSocket(/\/ws\/terminal\//, socket => { socket.send(Buffer.from("Font sample ABC 0123 中文 ⏵⏵\r\n")); });
}
async function settings(page: Page) {
  if (await page.getByTestId("mobile-workbench").isVisible()) await mobileOpenHostSheet(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "UI Font", exact: true })).toBeVisible();
}
async function options(page: Page) {
  return page.evaluate(() => {
    const term = (window as unknown as { __offdeskTerminals?: Map<string, Terminal> }).__offdeskTerminals?.get("font-test");
    return term ? { family: term.options.fontFamily, size: term.options.fontSize } : null;
  });
}
test("focused settings field stays visible when the keyboard shrinks the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await mockTerminal(page);
  await openApp(page);
  await settings(page);
  const field = page.getByRole("spinbutton", { name: "Terminal Font Size", exact: true });
  await field.focus();
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport!, "height", { configurable: true, value: 420 });
    window.visualViewport!.dispatchEvent(new Event("resize"));
  });
  await expect(page.getByTestId("terminal-canvas")).toHaveCSS("height", "420px");
  await expect.poll(() => field.evaluate(el => {
    const rect = el.getBoundingClientRect();
    const scroller = el.closest('[data-testid="settings-content"]')!.getBoundingClientRect();
    return rect.top >= scroller.top && rect.bottom <= scroller.bottom && rect.bottom <= 420;
  })).toBe(true);
  await expect(field).toBeFocused();
});
for (const width of [390, 1280]) {
  test(`font preferences apply, persist, reset and update a live terminal at ${width}px`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    await mockTerminal(page);
    await openApp(page);
    await expect.poll(() => options(page)).not.toBeNull();
    // Retain the actual instance: preference changes in another window must
    // update rendering without replacing the terminal or losing its buffer.
    await page.evaluate(() => {
      const win = window as unknown as { __offdeskTerminals: Map<string, Terminal>; savedTerminal?: Terminal };
      win.savedTerminal = win.__offdeskTerminals.get("font-test");
    });
    const preferences = await context.newPage();
    await mockTerminal(preferences);
    await openApp(preferences);
    await settings(preferences);
    await preferences.getByRole("combobox", { name: "UI Font", exact: true }).selectOption("Geist");
    await expect(preferences.locator("body")).toHaveCSS("font-family", /^'?"?Geist'?"?, system-ui/);
    await expect(page.locator("body")).toHaveCSS("font-family", /^'?"?Geist'?"?, system-ui/);
    await preferences.getByRole("combobox", { name: "Terminal Font", exact: true }).selectOption("Fira Code");
    await preferences.getByRole("spinbutton", { name: "Terminal Font Size", exact: true }).fill("20");
    await expect.poll(() => options(page)).toEqual({ family: "'Fira Code', 'JetBrains Mono', 'Offdesk Terminal Symbols', monospace", size: 20 });
    expect(await page.evaluate(() => Array.from(document.fonts).some(font => font.family.replace(/["']/g, "") === "JetBrains Mono" && font.status === "loaded"))).toBe(true);
    // Fira Code ships with the app, so the terminal really draws it.
    await expect.poll(() => page.evaluate(() => Array.from(document.fonts).some(font => font.family.replace(/["']/g, "") === "Fira Code" && font.status === "loaded"))).toBe(true);
    // Fonts the device lacks are not offered; the bundled ones always are.
    const offered = await preferences.getByRole("combobox", { name: "Terminal Font", exact: true }).locator("option").allTextContents();
    expect(offered).toEqual(expect.arrayContaining(["Geist Mono (included)", "Fira Code (included)", "IBM Plex Mono (included)", "Source Code Pro (included)"]));
    expect(offered).not.toContain("Consolas");
    expect(await page.evaluate(() => {
      const win = window as unknown as { __offdeskTerminals: Map<string, Terminal>; savedTerminal: Terminal };
      return win.savedTerminal === win.__offdeskTerminals.get("font-test");
    })).toBe(true);
    await preferences.getByTitle("Back", { exact: true }).click();
    await expect.poll(() => options(preferences)).toEqual({ family: "'Fira Code', 'JetBrains Mono', 'Offdesk Terminal Symbols', monospace", size: 20 });
    await page.reload();
    await expect(page.locator("body")).toHaveCSS("font-family", /^'?"?Geist'?"?, system-ui/);
    await expect.poll(() => options(page)).toEqual({ family: "'Fira Code', 'JetBrains Mono', 'Offdesk Terminal Symbols', monospace", size: 20 });
    await settings(preferences);
    await preferences.getByRole("combobox", { name: "UI Font", exact: true }).selectOption("System UI");
    await expect(preferences.locator("body")).toHaveCSS("font-family", /system-ui/);
    await preferences.getByRole("combobox", { name: "UI Font", exact: true }).selectOption("App Default");
    await expect(page.locator("body")).toHaveCSS("font-family", /Geist Mono/);
    await preferences.getByRole("combobox", { name: "Terminal Font", exact: true }).selectOption("App Default");
    await preferences.getByRole("spinbutton", { name: "Terminal Font Size", exact: true }).fill("");
    await expect.poll(async () => (await options(page))?.size).toBe(14);
    await expect.poll(async () => (await options(page))?.family).toBe("'JetBrains Mono', 'Offdesk Terminal Symbols', monospace");
    await context.close();
  });
}


test("mobile terminal keeps the default text face and loads its small playback-symbol fallback", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.addInitScript(() => localStorage.setItem("offdesk:terminal-font-family", "JetBrains Mono"));
  await mockTerminal(page);
  await openApp(page);
  await expect.poll(() => options(page)).not.toBeNull();
  // Inspect natural startup, without loading the font from the test itself.
  await expect.poll(() => page.evaluate(() => Array.from(document.fonts).some(face =>
    face.family.replace(/["']/g, "") === "Offdesk Terminal Symbols" && face.status === "loaded",
  ))).toBe(true);
  expect((await options(page))?.family).toBe("'JetBrains Mono', 'Offdesk Terminal Symbols', monospace");
  const different = await page.evaluate(() => {
    const render = (text: string, font = '40px "JetBrains Mono", "Offdesk Terminal Symbols", monospace') => {
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 80;
      const ctx = canvas.getContext("2d")!;
      ctx.font = font;
      ctx.fillText(text, 4, 52);
      return canvas.toDataURL();
    };
    return render("⏵") !== render("\u{10ffff}") && render("⏵") !== render("")
      && render("ABC 012") === render("ABC 012", '40px "JetBrains Mono", monospace');
  });
  expect(different).toBe(true);
});
test("iOS caps the viewport so focusing a small form field does not zoom", async ({ browser }) => {
  for (const [device, capped] of [["iPhone 14", true], ["Pixel 7", false]] as const) {
    const { defaultBrowserType: _, ...emulation } = devices[device];
    const context = await browser.newContext(emulation);
    const page = await context.newPage();
    await mockTerminal(page);
    await openApp(page);
    const viewport = await page.locator('meta[name="viewport"]').getAttribute("content");
    expect(viewport?.includes("maximum-scale=1"), device).toBe(capped);
    await context.close();
  }
});
test("Interface text size scales the interface's text", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mockTerminal(page);
  await openApp(page);
  await settings(page);
  const title = page.getByRole("heading", { name: "Settings", exact: true });
  const field = page.getByRole("spinbutton", { name: "UI Font Size", exact: true });
  await expect(title).toHaveCSS("font-size", "28px");
  const fieldSize = await field.evaluate(el => parseFloat(getComputedStyle(el).fontSize));
  await field.fill("20");
  await expect(title).toHaveCSS("font-size", "40px");
  await expect.poll(() => field.evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeCloseTo((fieldSize * 20) / 14, 1);
  await field.fill("");
  await expect(title).toHaveCSS("font-size", "28px");
});
