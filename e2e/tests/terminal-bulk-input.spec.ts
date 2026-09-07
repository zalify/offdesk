import { test, expect, devices } from "@playwright/test";
import { openApp, resetMachineState, requestMachineControl, createTerminalViaApi, expandTerminalById, readTerminalBuffer } from "./helpers";

// CI keeps its normal Chromium/container path. WebKit is opt-in for host
// debugging of the iOS/macOS report, not a replacement for container E2E.
test.use({ browserName: process.env.OFFDESK_DEBUG_WEBKIT ? "webkit" : "chromium" });
for (const device of ["iPhone 14", "Desktop Safari"]) {
  test.describe(device, () => {
    const { defaultBrowserType: _browserType, ...contextOptions } = devices[device];
    test.use(contextOptions);

test("bulk input and legacy keypress preserve a whole dictated paragraph", async ({ page }) => {
  const inputs: string[] = [];
  page.on("websocket", socket => socket.on("framesent", frame => {
    if (typeof frame.payload !== "string") return;
    try {
      const message = JSON.parse(frame.payload);
      if (message.type === "input") inputs.push(message.data);
    } catch { /* binary output */ }
  }));
  await openApp(page);
  await resetMachineState(page);
  await requestMachineControl(page);
  const id = await createTerminalViaApi(page, { cwd: "/tmp", startupCommand: "env BASH_SILENCE_DEPRECATION_WARNING=1 bash --noprofile --norc" });
  await expandTerminalById(page, id);
  await expect.poll(() => readTerminalBuffer(page, id)).toMatch(/bash-\d+\.\d+[#$]/);
  const textarea = page.locator(".xterm-helper-textarea").first();
  await textarea.focus();
  inputs.length = 0;
  const text = "这是一次语音输入测试，请保留整段文字，包括重复词测试测试、English 和标点。";
  await page.keyboard.insertText(text);
  await expect.poll(() => inputs.join("")).toBe(text);
  inputs.length = 0;
  // Legacy keypress carries the full string in key, while charCode only
  // represents its first UTF-16 unit. This explicitly exercises that event
  // shape; keyboard.insertText above exercises the real engine pipeline.
  await textarea.evaluate((element, text) => element.dispatchEvent(new KeyboardEvent("keypress", {
    bubbles: true, cancelable: true, key: text, charCode: text.charCodeAt(0), which: text.charCodeAt(0),
  })), text);
  await expect.poll(() => inputs.join("").replace(/\x1b\[20[01]~/g, "")).toBe(text);
});

test("iOS delayed 229 punctuation, tail replacement and dictation reach the terminal once", async ({ page }) => {
  test.skip(device !== "iPhone 14", "iOS text-input compatibility path");
  const inputs: string[] = [];
  page.on("websocket", socket => socket.on("framesent", frame => {
    if (typeof frame.payload !== "string") return;
    try { const message = JSON.parse(frame.payload); if (message.type === "input") inputs.push(message.data); } catch {}
  }));
  await openApp(page);
  await resetMachineState(page);
  await requestMachineControl(page);
  const id = await createTerminalViaApi(page, { cwd: "/tmp", startupCommand: "env BASH_SILENCE_DEPRECATION_WARNING=1 bash --noprofile --norc" });
  await expandTerminalById(page, id);
  await expect.poll(() => readTerminalBuffer(page, id)).toMatch(/bash-\d+\.\d+[#$]/);
  const textarea = page.locator(".xterm-helper-textarea").first();
  await textarea.focus();
  inputs.length = 0;
  await textarea.evaluate(async element => {
    const ta = element as HTMLTextAreaElement;
    const edit = (inputType: string, data: string | null, value: string) => {
      ta.dispatchEvent(new InputEvent("beforeinput", { inputType, data, bubbles: true, composed: true }));
      ta.value = value;
      ta.setSelectionRange(value.length, value.length);
      ta.dispatchEvent(new InputEvent("input", { inputType, data, bubbles: true, composed: true }));
    };
    ta.value = "";
    for (const char of ["，", "！", " "]) {
      ta.dispatchEvent(new KeyboardEvent("keydown", { key: char, keyCode: 229, bubbles: true }));
      // Replay the upstream iOS trace: the keydown timer finishes BEFORE
      // WebKit commits punctuation. A same-task insertion hides the bug.
      await new Promise(resolve => setTimeout(resolve, 20));
      edit("insertText", char, ta.value + char);
      ta.dispatchEvent(new KeyboardEvent("keyup", { key: char, keyCode: char === " " ? 32 : 0, bubbles: true }));
    }
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: " ", keyCode: 229, bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 20));
    edit("deleteContentBackward", null, ta.value.slice(0, -1));
    edit("insertText", "。", ta.value + "。");
    ta.dispatchEvent(new KeyboardEvent("keyup", { key: " ", keyCode: 32, bubbles: true }));
    const paragraph = "语音输入测试测试，English 🦊！";
    edit("insertReplacementText", paragraph, ta.value + paragraph);
    // Another commit in the same task must not be swallowed by a dedup timer.
    edit("insertText", "？", ta.value + "？");
  });
  await expect.poll(() => inputs.join("")).toBe("，！ \x7f。语音输入测试测试，English 🦊！？");
  // A fresh real keyboard input still uses xterm's normal deduplicated path.
  await page.keyboard.type("ab");
  await expect.poll(() => inputs.join("")).toBe("，！ \x7f。语音输入测试测试，English 🦊！？ab");
});

test("Paste sends the full paragraph without Enter, mode switching or keyboard focus", async ({ page }) => {
  test.skip(device !== "iPhone 14", "Mobile key bar behavior.");
  const text = "整段粘贴文字，保留重复词测试测试。\nSecond line 🦊";
  await page.addInitScript(text => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText: async () => text } });
  }, text);
  const inputs: string[] = [], commands: string[] = [];
  page.on("websocket", socket => socket.on("framesent", frame => {
    if (typeof frame.payload !== "string") return;
    try { const m = JSON.parse(frame.payload); if (m.type === "input") inputs.push(m.data); if (m.type === "command_input") commands.push(m.data); } catch {}
  }));
  await openApp(page); await resetMachineState(page); await requestMachineControl(page);
  const id = await createTerminalViaApi(page, { cwd: "/tmp", startupCommand: "env BASH_SILENCE_DEPRECATION_WARNING=1 bash --noprofile --norc" });
  await expandTerminalById(page, id);
  await expect.poll(() => readTerminalBuffer(page, id)).toMatch(/bash-\d+\.\d+[#$]/);
  inputs.length = 0;
  const textarea = page.locator(".xterm-helper-textarea").first();
  await expect(textarea).not.toBeFocused();
  await page.getByRole("button", { name: "Paste", exact: true }).tap();
  // xterm normalizes pasted line breaks to CR and honors bracketed paste.
  await expect.poll(() => inputs.join("")).toBe("\x1b[200~" + text.replaceAll("\n", "\r") + "\x1b[201~");
  expect(commands).toEqual([]);
  await expect(textarea).not.toBeFocused();
  await expect(page.getByTestId("composer-input")).toHaveCount(0);
  await page.getByTestId("extended-keybar-enter").tap();
  await expect.poll(() => commands).toEqual(["\r"]);
});

test("denied clipboard access reports an error and leaves direct input usable", async ({ page }) => {
  test.skip(device !== "iPhone 14", "Mobile key bar behavior.");
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText: async () => { throw new DOMException("Denied", "NotAllowedError"); } } });
  });
  await openApp(page); await resetMachineState(page); await requestMachineControl(page);
  const id = await createTerminalViaApi(page, { cwd: "/tmp" });
  await expandTerminalById(page, id);
  await page.getByRole("button", { name: "Paste", exact: true }).tap();
  await expect(page.getByRole("alert")).toContainText("Could not read the clipboard");
  await expect(page.getByTestId("composer-input")).toHaveCount(0);
  await page.getByTestId("extended-keybar-keyboard").tap();
  await expect(page.locator(".xterm-helper-textarea").first()).toBeFocused();
});

test("terminal Enter preserves focus after the OS dismisses the keyboard", async ({ page }) => {
  test.skip(device !== "iPhone 14", "Mobile key bar behavior.");
  const commands: string[] = [];
  page.on("websocket", socket => socket.on("framesent", frame => {
    if (typeof frame.payload !== "string") return;
    try { const m = JSON.parse(frame.payload); if (m.type === "command_input") commands.push(m.data); } catch {}
  }));
  await openApp(page);
  await resetMachineState(page);
  await requestMachineControl(page);
  const id = await createTerminalViaApi(page, { cwd: "/tmp" });
  await expandTerminalById(page, id);
  await page.getByTitle("Show keyboard", { exact: true }).click();
  const textarea = page.locator(".xterm-helper-textarea").first();
  await expect(textarea).toBeFocused();
  // Models dismissing the OS keyboard outside our toggle: the app's old
  // keyboardVisible flag remains true. Key-bar input must not refocus it.
  await textarea.evaluate((el: HTMLTextAreaElement) => el.blur());
  const enter = page.getByTestId("extended-keybar-enter");
  await enter.click();
  await expect.poll(() => commands.join("")).toBe("\r");
  await expect(textarea).not.toBeFocused();
  await textarea.focus();
  await enter.click();
  await expect.poll(() => commands.join("")).toBe("\r\r");
  await expect(textarea).toBeFocused();
});

  });
}
