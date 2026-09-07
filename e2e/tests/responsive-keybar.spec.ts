import { test, expect, devices } from "@playwright/test";
import { chooseInputMode, openApp, resetMachineState, requestMachineControl, createTerminalViaApi, expandTerminalById, readTerminalBuffer } from "./helpers";

test.use({ ...devices["iPhone 14"], browserName: "chromium" });

async function setup(page: import("@playwright/test").Page) {
  await openApp(page); await resetMachineState(page); await requestMachineControl(page);
  const id = await createTerminalViaApi(page, { cwd: "/tmp", startupCommand: "env BASH_SILENCE_DEPRECATION_WARNING=1 bash --noprofile --norc" });
  await expandTerminalById(page, id);
  await expect.poll(() => readTerminalBuffer(page, id)).toMatch(/bash-\d+\.\d+[#$]/);
  return id;
}

test("equal keys and fixed inverted-T survive scrolling, folding and rotation", async ({ page }, testInfo) => {
  await setup(page);
  await chooseInputMode(page, true);
  await page.getByTestId("composer-input").fill("Preserve this draft 🦊");
  // Production typography follows the design system and user font override,
  // rather than the wireframe's hard-coded system font.
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--font-display", "monospace");
    document.documentElement.style.setProperty("--font-sans", "serif");
  });
  await expect(page.getByTestId("extended-keybar-esc")).toHaveCSS("font-family", "monospace");
  await expect(page.getByTestId("composer-input")).toHaveCSS("font-family", "serif");
  await page.evaluate(() => {
    document.documentElement.style.removeProperty("--font-display");
    document.documentElement.style.removeProperty("--font-sans");
  });
  for (const width of [320, 390, 820, 960, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const bar = page.getByTestId("extended-keybar").filter({ visible: true });
    await expect(bar).toBeVisible();
    await expect(page.getByTestId("composer-input").filter({ visible: true })).toHaveValue("Preserve this draft 🦊");
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
    await expect(bar.getByTestId("extended-keybar-shift-tab")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`keybar-${width}.png`) });
  }
});

test("local arrows and symbols edit at the caret; Enter sends once and swipe cancels activation", async ({ page }) => {
  const commands: string[] = [];
  const sends: string[] = [];
  page.on("websocket", socket => socket.on("framesent", frame => {
    if (typeof frame.payload !== "string") return;
    try { const m = JSON.parse(frame.payload); if (m.type === "command_input") commands.push(m.data); if (m.type === "composer") sends.push(frame.payload); } catch {}
  }));
  await setup(page);
  await page.getByTitle("Show keyboard", { exact: true }).click();
  await page.getByTestId("terminal-input-settings").click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Input settings", exact: true })).toHaveCount(0);
  expect(commands).toEqual([]);
  await chooseInputMode(page, true);
  const input = page.getByTestId("composer-input");
  await expect(input).toHaveAttribute("rows", "1");
  await input.fill("echo ab");
  await input.evaluate((el: HTMLTextAreaElement) => { el.setSelectionRange(6, 6); el.blur(); });
  await page.getByTestId("extended-keybar-left").click();
  await expect.poll(() => input.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(5);
  await page.getByTestId("extended-keybar-slash").click();
  await expect(input).toHaveValue("echo /ab");
  await expect(input).not.toBeFocused();
  expect(commands).toEqual([]);
  // IME confirmation must not submit, while native Shift+Enter adds a line.
  await input.dispatchEvent("compositionstart");
  await page.getByTestId("extended-keybar-enter").click();
  expect(sends).toHaveLength(0);
  await input.dispatchEvent("compositionend");
  const space = page.getByTestId("extended-keybar-space");
  await space.scrollIntoViewIfNeeded();
  await space.dispatchEvent("pointerdown", { button: 0, clientX: 50, clientY: 20 });
  await space.dispatchEvent("pointermove", { clientX: 90, clientY: 20 });
  await space.dispatchEvent("pointerup");
  await space.dispatchEvent("click", { detail: 1 });
  await expect(input).toHaveValue("echo /ab");
  await input.fill("echo KEYBAR_DELIVERED");
  await input.evaluate((el: HTMLTextAreaElement) => el.blur());
  await page.getByTestId("extended-keybar-enter").click();
  await expect(input).toHaveValue("");
  expect(sends).toHaveLength(1);
  await expect(input).not.toBeFocused();
  await page.getByTestId("extended-keybar-enter").click();
  await expect.poll(() => commands).toEqual(["\r"]);
});

test("touch key taps consume the native default action without changing input focus", async ({ page }) => {
  const commands: string[] = [];
  const sends: string[] = [];
  page.on("websocket", socket => socket.on("framesent", frame => {
    if (typeof frame.payload !== "string") return;
    try {
      const message = JSON.parse(frame.payload);
      if (message.type === "command_input") commands.push(message.data);
      if (message.type === "composer") sends.push(frame.payload);
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

  await chooseInputMode(page, true);
  const input = page.getByTestId("composer-input");
  await input.fill("echo TOUCH_ENTER_DELIVERED");
  await input.evaluate((el: HTMLTextAreaElement) => el.blur());
  await enter.tap();
  await expect(input).toHaveValue("");
  await expect(enter).toHaveAttribute("data-touch-default-cancelled", "true");
  await expect(input).not.toBeFocused();
  expect(sends).toHaveLength(1);
  expect(commands).toEqual(["\r", "\r", "\x1b[D"]);
});

test("IME dismissal releases retained focus and every command key keeps it closed", async ({ page }) => {
  await setup(page);
  const keyboard = page.getByTestId("extended-keybar-keyboard");
  const direct = page.locator(".xterm-helper-textarea").first();
  const nativeVisibility = (visible: boolean) => page.evaluate(value => {
    window.dispatchEvent(new CustomEvent("offdesk:keyboard-visibility", { detail: value }));
  }, visible);
  const keys = ["enter", "tab", "esc", "up", "down", "left", "right", "ctrl-c"];
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

  await chooseInputMode(page, true);
  const editor = page.getByTestId("composer-input");
  await editor.fill("echo IME_DISMISSED_DRAFT");
  await nativeVisibility(true);
  await nativeVisibility(false);
  await expect(editor).not.toBeFocused();
  await page.getByTestId("extended-keybar-left").tap();
  await expect(editor).not.toBeFocused();
  await page.getByTestId("extended-keybar-enter").tap();
  await expect(editor).toHaveValue("");
  await expect(editor).not.toBeFocused();
});
