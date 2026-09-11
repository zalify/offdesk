import { test, expect, devices } from "@playwright/test";
import { openApp, resetMachineState, requestMachineControl, createTerminalViaApi, expandTerminalById, readTerminalBuffer } from "./helpers";

test.use({ ...devices["iPhone 14"], browserName: "chromium" });

async function setup(page: import("@playwright/test").Page) {
  await openApp(page); await resetMachineState(page); await requestMachineControl(page);
  const id = await createTerminalViaApi(page, { cwd: "/tmp", startupCommand: "env BASH_SILENCE_DEPRECATION_WARNING=1 bash --noprofile --norc" });
  await expandTerminalById(page, id);
  await expect.poll(() => readTerminalBuffer(page, id)).toMatch(/bash-\d+\.\d+[#$]/);
  return id;
}

test("keyboard viewport pan keeps the key bar and terminal chrome in the visible area", async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    const viewport = window.visualViewport!;
    Object.defineProperty(viewport, "height", { configurable: true, value: 420 });
    Object.defineProperty(viewport, "offsetTop", { configurable: true, value: 96 });
    viewport.dispatchEvent(new Event("resize"));
    viewport.dispatchEvent(new Event("scroll"));
  });
  const canvas = page.getByTestId("terminal-canvas");
  await expect(canvas).toHaveCSS("height", "420px");
  await expect(canvas).toHaveCSS("top", "96px");
  await expect.poll(() => page.getByTestId("extended-keybar").evaluate(el => {
    const rect = el.getBoundingClientRect();
    return rect.top >= 96 && rect.bottom <= 516;
  })).toBe(true);
  await page.evaluate(() => {
    const viewport = window.visualViewport!;
    Object.defineProperty(viewport, "height", { configurable: true, value: 800 });
    Object.defineProperty(viewport, "offsetTop", { configurable: true, value: 0 });
    viewport.dispatchEvent(new Event("resize"));
  });
  await expect(canvas).toHaveCSS("top", "0px");
});

test("equal keys and fixed inverted-T survive scrolling, folding and rotation", async ({ page }, testInfo) => {
  await setup(page);
  // Production typography follows the design system and user font override,
  // rather than the wireframe's hard-coded system font.
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--font-display", "monospace");
    document.documentElement.style.setProperty("--font-sans", "serif");
  });
  await expect(page.getByTestId("extended-keybar-esc")).toHaveCSS("font-family", "monospace");
  await page.evaluate(() => {
    document.documentElement.style.removeProperty("--font-display");
    document.documentElement.style.removeProperty("--font-sans");
  });
  for (const width of [320, 390, 820, 960, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const bar = page.getByTestId("extended-keybar").filter({ visible: true });
    await expect(bar).toBeVisible();
    await expect(page.getByTestId("terminal-input-settings")).toHaveCount(0);
    await expect.poll(async () => {
      return bar.evaluate(el => {
        const width = el.clientWidth - 8;
        const expected = width / Math.max(7, Math.floor(width / 52));
        const boxes = Array.from(el.querySelectorAll(".offdesk-terminal-key"), key => key.getBoundingClientRect());
        return boxes.every(box => box.width >= 44 && box.height === 44 && Math.abs(box.width - expected) < 1);
      });
    }).toBe(true);
    const up = bar.getByTestId("extended-keybar-up");
    const left = bar.getByTestId("extended-keybar-left"), right = bar.getByTestId("extended-keybar-right");
    const before = await up.boundingBox();
    // Read both rows in one frame: separate protocol round trips can straddle
    // the ResizeObserver update immediately after a viewport change.
    await expect.poll(() => bar.evaluate(el => Math.abs(
      el.querySelector('[data-testid="extended-keybar-up"]')!.getBoundingClientRect().x -
      el.querySelector('[data-testid="extended-keybar-down"]')!.getBoundingClientRect().x,
    ))).toBeLessThan(1);
    expect((await left.boundingBox())!.x).toBeLessThan(before!.x);
    expect((await right.boundingBox())!.x).toBeGreaterThan(before!.x);
    const scroll = bar.getByTestId("keybar-scroll");
    if (width === 320) {
      // Exercise Chromium's actual touch scrolling, starting over a tool key.
      // Programmatic scroll alone would miss touch-action/focus regressions.
      await scroll.evaluate(el => { el.scrollLeft = 0; });
      const bounds = (await scroll.boundingBox())!;
      const cdp = await page.context().newCDPSession(page);
      const x = bounds.x + bounds.width - 12, y = bounds.y + bounds.height / 2;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      for (let delta = 10; delta < bounds.width - 20; delta += 10) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x - delta, y }] });
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await expect.poll(() => scroll.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await cdp.detach();
    }
    await scroll.evaluate(el => { el.scrollLeft = el.scrollWidth; });
    expect((await up.boundingBox())!.x).toBe(before!.x);
    await expect(bar.getByTestId("extended-keybar-keyboard")).toBeInViewport();
    await expect(bar.getByTestId("extended-keybar-ctrl-c")).toBeInViewport();
    await expect(bar.getByTestId("extended-keybar-tab")).toBeInViewport();
    await expect(bar.getByTestId("extended-keybar-enter")).toBeInViewport();
    await expect(bar.getByTestId("extended-keybar-shift-tab")).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath(`keybar-${width}.png`) });
  }
});

test("touch key taps consume the native default action without changing input focus", async ({ page }) => {
  const commands: string[] = [];
  page.on("websocket", socket => socket.on("framesent", frame => {
    if (typeof frame.payload !== "string") return;
    try {
      const message = JSON.parse(frame.payload);
      if (message.type === "command_input") commands.push(message.data);
    } catch {}
  }));
  await setup(page);
  // Browser emulation cannot display/dismiss the OS keyboard. Observe the
  // cancelable touch default as well as focus: OS dismissal can leave the
  // editable focused, which the older blur-only regression did not cover.
  await page.evaluate(() => {
    document.addEventListener("touchend", event => {
      const button = (event.target as Element).closest(".offdesk-terminal-key");
      if (button) button.setAttribute("data-touch-default-cancelled", String(event.defaultPrevented));
    }, { passive: true });
  });
  const enter = page.getByTestId("extended-keybar-enter");
  const keyboard = page.getByTestId("extended-keybar-keyboard");
  const textarea = page.locator(".xterm-helper-textarea").first();
  await expect(textarea).not.toBeFocused();
  await enter.tap();
  await expect(enter).toHaveAttribute("data-touch-default-cancelled", "true");
  await expect.poll(() => commands).toEqual(["\r"]);
  await expect(textarea).not.toBeFocused();

  // Only the explicit keyboard toggle may focus the terminal. A subsequent
  // Enter must retain focus and must not fall through to the native tap.
  await keyboard.tap();
  await expect(textarea).toBeFocused();
  await enter.tap();
  await expect.poll(() => commands).toEqual(["\r", "\r"]);
  await expect(textarea).toBeFocused();
  await keyboard.tap();
  await expect(textarea).not.toBeFocused();
  await page.getByTestId("extended-keybar-left").tap();
  await expect.poll(() => commands).toEqual(["\r", "\r", "\x1b[D"]);
  await expect(textarea).not.toBeFocused();
  const space = page.getByTestId("extended-keybar-space");
  await space.scrollIntoViewIfNeeded();
  await space.dispatchEvent("pointerdown", { button: 0, clientX: 50, clientY: 20 });
  await space.dispatchEvent("pointermove", { clientX: 90, clientY: 20 });
  await space.dispatchEvent("pointerup");
  await space.dispatchEvent("click", { detail: 1 });
  expect(commands).toEqual(["\r", "\r", "\x1b[D"]);

});

test("IME dismissal releases retained focus and every command key keeps it closed", async ({ page }) => {
  await setup(page);
  const keyboard = page.getByTestId("extended-keybar-keyboard");
  const direct = page.locator(".xterm-helper-textarea").first();
  const nativeVisibility = (visible: boolean) => page.evaluate(value => {
    window.dispatchEvent(new CustomEvent("offdesk:keyboard-visibility", { detail: value }));
  }, visible);
  const keys = ["enter", "tab", "esc", "up", "down", "left", "right", "ctrl-c", "shift-tab", "backspace"];
  for (const name of keys) {
    await keyboard.tap();
    await expect(direct).toBeFocused();
    await nativeVisibility(true);
    // This is the IME's own hide button: no synthetic DOM blur in the test.
    await nativeVisibility(false);
    await expect(direct).not.toBeFocused();
    await expect(keyboard).toHaveAttribute("aria-label", "Show keyboard");
    await page.getByTestId(`extended-keybar-${name}`).tap();
    await expect(direct).not.toBeFocused();
  }
  await keyboard.tap();
  await nativeVisibility(true);
  await page.getByTestId("extended-keybar-enter").tap();
  await expect(direct).toBeFocused();
  await nativeVisibility(false);
});

test("custom terminal keys persist while fixed navigation stays aligned", async ({ page }) => {
  const id = await setup(page);
  const { mobileOpenHostSheet } = await import("./helpers");
  await mobileOpenHostSheet(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByText("Customize terminal keys", { exact: true }).click();
  const settings = page.getByTestId("keybar-settings");
  await settings.getByRole("button", { name: "Hide /", exact: true }).click();
  await settings.getByRole("button", { name: "Move Backspace to first row", exact: true }).click();
  await expect(settings.getByRole("button", { name: "Move Shift earlier", exact: true })).toBeDisabled();
  await settings.getByRole("combobox", { name: "Add key to second row" }).selectOption("home");
  await page.reload();
  await expandTerminalById(page, id);
  const bar = page.getByTestId("extended-keybar");
  await expect(bar.getByTestId("extended-keybar-slash")).toHaveCount(0);
  await expect(bar.getByTestId("keybar-fixed-row").getByTestId("extended-keybar-backspace")).toBeVisible();
  await expect(bar.getByTestId("extended-keybar-home")).toHaveCount(1);
  await expect.poll(() => bar.evaluate(el => Math.abs(
    el.querySelector('[data-testid="extended-keybar-up"]')!.getBoundingClientRect().x -
    el.querySelector('[data-testid="extended-keybar-down"]')!.getBoundingClientRect().x))).toBeLessThan(1);
  await mobileOpenHostSheet(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByText("Customize terminal keys", { exact: true }).click();
  await settings.getByRole("button", { name: "Restore default keys" }).click();
  await page.reload();
  await expandTerminalById(page, id);
  await expect(page.getByTestId("extended-keybar-slash")).toBeVisible();
});

test("Shift tap and two-finger hold modify commands and always release", async ({ page }) => {
  const commands: string[] = [];
  page.on("websocket", socket => socket.on("framesent", frame => {
    try { const m = JSON.parse(String(frame.payload)); if (m.type === "command_input") commands.push(m.data); } catch {}
  }));
  await setup(page);
  const shift = page.getByTestId("extended-keybar-shift");
  const tab = page.getByTestId("extended-keybar-tab");
  const textarea = page.locator(".xterm-helper-textarea").first();
  await shift.scrollIntoViewIfNeeded();
  await shift.tap();
  await expect(shift).toHaveAttribute("aria-pressed", "true");
  await tab.tap();
  await expect.poll(() => commands).toEqual(["\x1b[Z"]);
  await expect(shift).toHaveAttribute("aria-pressed", "false");
  await tab.tap();
  await expect.poll(() => commands).toEqual(["\x1b[Z", "\t"]);
  const cdp = await page.context().newCDPSession(page);
  const a = (await shift.boundingBox())!, b = (await tab.boundingBox())!;
  const first = { id: 1, x: a.x + a.width / 2, y: a.y + a.height / 2 };
  const second = { id: 2, x: b.x + b.width / 2, y: b.y + b.height / 2 };
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [first] });
  for (let i = 0; i < 2; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [first, second] });
    // End only the Tab contact; ending the Shift contact would test a latch instead of a hold.
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [second] });
    await expect(shift).toHaveAttribute("aria-pressed", "true");
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(() => commands).toEqual(["\x1b[Z", "\t", "\x1b[Z", "\x1b[Z"]);
  await expect(shift).toHaveAttribute("aria-pressed", "false");
  await page.getByTestId("extended-keybar-up").tap();
  await expect.poll(() => commands.at(-1)).toBe("\x1b[A");
  await shift.tap();
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(shift).toHaveAttribute("aria-pressed", "false");
  await expect(textarea).not.toBeFocused();
  await cdp.detach();
});

test("Backspace taps once, holds to repeat, and scrolling never deletes", async ({ page }) => {
  const commands: string[] = [];
  page.on("websocket", socket => socket.on("framesent", frame => {
    try { const m = JSON.parse(String(frame.payload)); if (m.type === "command_input") commands.push(m.data); } catch {}
  }));
  await setup(page);
  const backspace = page.getByTestId("extended-keybar-backspace");
  await backspace.tap();
  await expect.poll(() => commands).toEqual(["\x7f"]);
  const cdp = await page.context().newCDPSession(page);
  const box = (await backspace.boundingBox())!;
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
  await expect.poll(() => commands.length).toBeGreaterThan(3);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  const count = commands.length;
  await page.waitForTimeout(200);
  expect(commands).toHaveLength(count);
  expect(commands.every(key => key === "\x7f")).toBe(true);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...point, x: point.x - 35 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(400);
  expect(commands).toHaveLength(count);
  await expect(page.locator(".xterm-helper-textarea").first()).not.toBeFocused();
  await cdp.detach();
});
