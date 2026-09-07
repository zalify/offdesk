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

test.use({
  ...devices["iPhone 14"],
  browserName: "chromium",
});

// Mobile IME duplicate-character regressions live in xterm's CompositionHelper
// and only manifest through Chromium's real editing pipeline — hand-dispatched
// composition events don't take the same code paths. CDP Input.imeSetComposition
// / Input.insertText produce trusted compositionstart/update/end and input
// events, the same events a mobile IME (WeChat keyboard) generates.
//
// Byte-exactness is asserted on window.__wsInputLog (every {type:"input"}
// payload the client sends), not on shell echo — echo can hide duplicates
// when the shell collapses or overwrites them.

interface WsInputLogWindow {
  __wsInputLog?: string[];
}

async function installWsInputLog(page: Page): Promise<void> {
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
          const payload = JSON.parse(data) as {
            type?: string;
            data?: string;
          };
          if (payload?.type === "input" && typeof payload.data === "string") {
            win.__wsInputLog!.push(payload.data);
          }
        } catch {
          // Not a JSON control message — ignore.
        }
      }
      return originalSend.call(this, data);
    };
  });
}

async function readWsInput(page: Page): Promise<string> {
  return page.evaluate(
    () =>
      ((window as unknown as WsInputLogWindow).__wsInputLog ?? []).join(""),
  );
}

async function clearWsInputLog(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as WsInputLogWindow).__wsInputLog = [];
  });
}

// CDP IME calls target the focused element, so xterm's hidden textarea must
// hold focus. Focus it through the terminal instance rather than tapping —
// a tap would send SGR mouse reports that pollute __wsInputLog.
async function focusTerminal(page: Page, terminalId: string): Promise<void> {
  await page.evaluate((tid) => {
    const map = (
      window as unknown as {
        __offdeskTerminals?: Map<string, { focus(): void }>;
      }
    ).__offdeskTerminals;
    map?.get(tid)?.focus();
  }, terminalId);
  const focused = await page.evaluate(() =>
    document.activeElement?.classList.contains("xterm-helper-textarea"),
  );
  expect(focused, "xterm helper textarea is not focused").toBe(true);
}

async function keydown229(cdp: CDPSession): Promise<void> {
  // Mobile IMEs prefix composition with a Process keydown (keyCode 229).
  await cdp.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    windowsVirtualKeyCode: 229,
    key: "Process",
  });
}

async function compose(cdp: CDPSession, text: string): Promise<void> {
  await cdp.send("Input.imeSetComposition", {
    text,
    selectionStart: text.length,
    selectionEnd: text.length,
  });
}

async function commit(cdp: CDPSession, text: string): Promise<void> {
  await cdp.send("Input.insertText", { text });
}

test.beforeEach(async ({ page }) => {
  await installWsInputLog(page);
  await openApp(page);
  await resetMachineState(page);
  await mobileTakeControl(page);
});

async function setupShellTerminal(page: Page): Promise<string> {
  const terminalId = await createTerminalViaApi(page, { cwd: "/tmp", startupCommand: "env BASH_SILENCE_DEPRECATION_WARNING=1 bash --noprofile --norc" });
  await expandTerminalById(page, terminalId);
  await expect(getImmersiveTerminal(page)).toBeVisible();
  // Wait for the bash prompt to render.
  await expect
    .poll(() => readTerminalBuffer(page, terminalId), { timeout: 15_000 })
    .toMatch(/bash-\d+\.\d+[#$]\s*$/);
  await focusTerminal(page, terminalId);
  await clearWsInputLog(page);
  return terminalId;
}

async function expectWsInput(page: Page, expected: string): Promise<void> {
  let log: string[] = [];
  try {
    await expect
      .poll(
        async () => {
          log = await page.evaluate(
            () => (window as unknown as WsInputLogWindow).__wsInputLog ?? [],
          );
          return log.join("");
        },
        { timeout: 5_000 },
      )
      .toBe(expected);
  } catch {
    // Poll errors only show the joined string. Re-assert so a mismatch
    // prints the raw per-message array (which messages doubled/dropped).
  }
  expect(
    log.join(""),
    `per-message input log: ${JSON.stringify(log)}`,
  ).toBe(expected);
}

test("IME plain CJK commit sends the committed string exactly once", async ({
  page,
}) => {
  const terminalId = await setupShellTerminal(page);
  const cdp = await page.context().newCDPSession(page);

  // Pinyin-style: n → ni → 你, commit 你好.
  await keydown229(cdp);
  await compose(cdp, "n");
  await compose(cdp, "ni");
  await compose(cdp, "你");
  await commit(cdp, "你好");

  await expectWsInput(page, "你好");

  // The prompt must echo the committed text exactly once — this is the
  // user-visible duplicate check.
  await expect
    .poll(
      async () => {
        const text = await readTerminalBuffer(page, terminalId);
        return text.split("你好").length - 1;
      },
      { timeout: 10_000 },
    )
    .toBe(1);
});

test("IME commit-then-continue does not resend the previous commit", async ({
  page,
}) => {
  await setupShellTerminal(page);
  const cdp = await page.context().newCDPSession(page);

  // Wubi/WeChat dual-function key pattern (upstream xterm issue #5023):
  // commit, then immediately start a new composition in the same tick
  // sequence.
  await keydown229(cdp);
  await compose(cdp, "henhen");
  await commit(cdp, "狠狠");
  await compose(cdp, "d");
  await compose(cdp, "de");
  await commit(cdp, "的");

  await expectWsInput(page, "狠狠的");
});

test("IME ASCII typed right after a CJK commit is not swallowed or doubled", async ({
  page,
}) => {
  await setupShellTerminal(page);
  const cdp = await page.context().newCDPSession(page);

  await compose(cdp, "ni");
  await compose(cdp, "你");
  await commit(cdp, "你好");
  await expectWsInput(page, "你好");
  // A bare character after compositionend. Do not prefix this insertText
  // with a separate CDP 229: CompositionHelper._handleAnyTextareaChanges
  // snapshots on that keydown and sends the diff on setTimeout(0), which
  // fires in the CDP round-trip gap *before* insertText, sees no change,
  // and drops the character (_inputEvent is also gated while _keyDownSeen).
  // insertText alone (inputType=insertText, not composing) is the
  // CoreBrowserTerminal._inputEvent path.
  await commit(cdp, "1");

  await expectWsInput(page, "你好1");
});

test("IME rapid repeated commits send each commit exactly once", async ({
  page,
}) => {
  await setupShellTerminal(page);
  const cdp = await page.context().newCDPSession(page);

  // Catches stale-textarea resends: the helper must not re-emit the previous
  // commit's text on the next composition lifecycle.
  //
  // First-round runs of this scenario saw 测×12 on the wire while the
  // helper textarea held 测×5. That sequence used Input.insertText without
  // a preceding imeSetComposition. Chromium then fires inputType=insertText
  // (CoreBrowserTerminal._inputEvent) and, if a 229 keydown is in flight,
  // CompositionHelper._handleAnyTextareaChanges (setTimeout 0) against the
  // same textarea; the two paths overlap and the 0ms timer can send a
  // prefix of the accumulated value. Real IMEs commit through
  // compositionend (inputType=insertCompositionText), which _inputEvent
  // ignores. Drive that path: compose, then insertText.
  await keydown229(cdp);
  for (let i = 0; i < 5; i++) {
    await compose(cdp, "ce");
    await commit(cdp, "测");
  }

  await expectWsInput(page, "测测测测测");
});

test("IME English composition commits plain ASCII exactly once", async ({
  page,
}) => {
  await setupShellTerminal(page);
  const cdp = await page.context().newCDPSession(page);

  // WeChat keyboard composes ASCII too when prediction is on.
  await keydown229(cdp);
  await compose(cdp, "h");
  await compose(cdp, "he");
  await compose(cdp, "hello");
  await commit(cdp, "hello");

  await expectWsInput(page, "hello");
});
