import { test, expect, devices } from "@playwright/test";
import type { CDPSession, Page } from "@playwright/test";

import {
  createTerminalViaApi,
  expandTerminalById,
  getImmersiveTerminal,
  mobileTakeControl,
  openApp,
  readTerminalBuffer,
  resetMachineState,
} from "./helpers";

// Android IME input. mobile-ime-composition.spec.ts runs as an iPhone, where
// appleTerminalInput takes over insertText; on Android, an IME commit without
// a composition (keydown 229, then the textarea grows) is sent only by
// CompositionHelper's 229 diff (_handleAnyTextareaChanges), so it needs an
// Android user agent to be exercised at all.
test.use({
  ...devices["Pixel 7"],
  browserName: "chromium",
});

interface WsInputLogWindow {
  __wsInputLog?: string[];
  __offdeskTerminals?: Map<string, { focus(): void }>;
}

test.beforeEach(async ({ page }) => {
  await page.context().addInitScript(() => {
    const win = window as unknown as WsInputLogWindow;
    win.__wsInputLog = [];
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (
      this: WebSocket,
      data: string | ArrayBufferLike | Blob | ArrayBufferView,
    ) {
      if (typeof data === "string") {
        try {
          const payload = JSON.parse(data) as { type?: string; data?: string };
          if (payload?.type === "input" && typeof payload.data === "string") {
            win.__wsInputLog!.push(payload.data);
          }
        } catch {
          // Not a JSON control message.
        }
      }
      return originalSend.call(this, data);
    };
  });
  await openApp(page);
  await resetMachineState(page);
  await mobileTakeControl(page);
});

async function clearWsInputLog(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as WsInputLogWindow).__wsInputLog = [];
  });
}

async function expectWsInput(page: Page, expected: string): Promise<void> {
  const read = () =>
    page.evaluate(() => (window as unknown as WsInputLogWindow).__wsInputLog ?? []);
  await expect
    .poll(async () => (await read()).join(""), { timeout: 5_000 })
    .toBe(expected)
    .catch(() => {});
  const log = await read();
  expect(log.join(""), `per-message input log: ${JSON.stringify(log)}`).toBe(expected);
}

async function setupShellTerminal(page: Page): Promise<void> {
  const terminalId = await createTerminalViaApi(page, {
    cwd: "/tmp",
    startupCommand: "env BASH_SILENCE_DEPRECATION_WARNING=1 bash --noprofile --norc",
  });
  await expandTerminalById(page, terminalId);
  await expect(getImmersiveTerminal(page)).toBeVisible();
  await expect
    .poll(() => readTerminalBuffer(page, terminalId), { timeout: 15_000 })
    .toMatch(/bash-\d+\.\d+[#$]\s*$/);
  // Focus through the terminal instance: a tap would send mouse reports.
  await page.evaluate((tid) => {
    (window as unknown as WsInputLogWindow).__offdeskTerminals?.get(tid)?.focus();
  }, terminalId);
  await expect
    .poll(() =>
      page.evaluate(() =>
        document.activeElement?.classList.contains("xterm-helper-textarea"),
      ),
    )
    .toBe(true);
  await clearWsInputLog(page);
}

async function composeAndCommit(cdp: CDPSession, preedit: string, text: string) {
  await cdp.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    windowsVirtualKeyCode: 229,
    key: "Process",
  });
  await cdp.send("Input.imeSetComposition", {
    text: preedit,
    selectionStart: preedit.length,
    selectionEnd: preedit.length,
  });
  await cdp.send("Input.insertText", { text });
}

// Chrome on Android, for an IME commitText with no composition: keydown
// (keyCode 229), the textarea grows, then a composed insertText input event,
// which xterm's _inputEvent skips after a keydown — only the 229 diff sends
// it. Dispatched in one task in-page: separate CDP calls let the diff's 0ms
// timer run before the text lands, and Input.insertText takes another path.
async function commitWithoutComposition(page: Page, text: string): Promise<void> {
  await page.evaluate((value) => {
    const textarea = document.activeElement as HTMLTextAreaElement;
    const keydown = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      composed: true,
      key: "Process",
    });
    Object.defineProperty(keydown, "keyCode", { value: 229 });
    Object.defineProperty(keydown, "which", { value: 229 });
    textarea.dispatchEvent(keydown);
    textarea.value += value;
    textarea.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        composed: true,
        inputType: "insertText",
        data: value,
      }),
    );
  }, text);
}

test("Android IME commit after Enter cleared the textarea keeps its first characters", async ({
  page,
}) => {
  await setupShellTerminal(page);
  const cdp = await page.context().newCDPSession(page);

  // A composition commit sends 你好; the input patch now counts the
  // textarea's first two characters as sent.
  await composeAndCommit(cdp, "ni", "你好");
  await expectWsInput(page, "你好");

  // Enter: xterm empties its textarea on the CR keydown, without the patch
  // seeing it.
  await page.keyboard.press("Enter");
  await expectWsInput(page, "你好\r");
  await clearWsInputLog(page);

  // The next commit used to be cut at the stale count of two: 世界 was sent,
  // 你好 was lost.
  await commitWithoutComposition(page, "你好世界");
  await expectWsInput(page, "你好世界");
});
