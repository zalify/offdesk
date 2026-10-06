import {
  expect,
  test,
  devices,
  type CDPSession,
  type Page,
} from "@playwright/test";

import {
  agentBrowserSnapshotViaApi,
  closeAgentBrowserViaApi,
  createTerminalViaApi,
  getAgentBrowserViaApi,
  getImmersiveTerminal,
  openAgentBrowserViaApi,
  openApp,
  requestAgentBrowserHandoffViaApi,
  requestMachineControl,
  resetMachineState,
} from "./helpers";

// The same phone emulation the other mobile specs use.
test.use({
  ...devices["iPhone 14"],
  browserName: "chromium",
});

// A page whose background animates so the screencast keeps producing frames,
// with widgets at known viewport positions (1280x800):
//   button  (100,200) 160x60      input (100,300) 400x40
//   output  (100,360)             status (100,420)
//   right-click target (100,480) 300x80
//   a fixed scroll indicator at (700,20); the document is 3000px tall.
function phonePage(title = "Phone page"): string {
  const html =
    `<title>${title}</title>` +
    "<style>@keyframes pulse{from{background:#fdd}to{background:#ddf}}" +
    "html{animation:pulse .5s infinite alternate}</style>" +
    "<body style='margin:0;font:16px sans-serif;height:3000px'>" +
    "<button id=b style='position:absolute;left:100px;top:200px;width:160px;height:60px' " +
    "onclick=\"c.textContent='clicked'\">Go</button>" +
    "<input id=i aria-label=Name style='position:absolute;left:100px;top:300px;" +
    "width:400px;height:40px;box-sizing:border-box' " +
    "oninput=\"o.textContent='typed:'+this.value\">" +
    "<div id=o style='position:absolute;left:100px;top:360px'>typed:</div>" +
    "<div id=c style='position:absolute;left:100px;top:420px'>idle</div>" +
    "<div id=r style='position:absolute;left:100px;top:480px;width:300px;height:80px' " +
    "oncontextmenu=\"this.textContent='rightclick';return false\">menu</div>" +
    "<div id=y style='position:fixed;left:700px;top:20px;font-size:32px'>scrollY:0</div>" +
    "<script>addEventListener('scroll',()=>{y.textContent='scrollY:'+Math.round(scrollY)})</script>";
  return `data:text/html,${encodeURIComponent(html)}`;
}

const body = (page: Page) => page.getByTestId("mobile-agent-browser-body");
const canvas = (page: Page) => page.getByTestId("mobile-agent-browser-canvas");

async function frames(page: Page): Promise<number> {
  return Number((await canvas(page).getAttribute("data-frames")) ?? 0);
}

/** Client position of a 1280x800 viewport point, through the local zoom. */
async function viewportToClient(
  page: Page,
  x: number,
  y: number,
): Promise<{ x: number; y: number }> {
  const box = await body(page).boundingBox();
  expect(box).toBeTruthy();
  const matrix = await canvas(page).evaluate((node) => {
    const m = new DOMMatrixReadOnly(getComputedStyle(node).transform);
    return { s: m.a, tx: m.e, ty: m.f };
  });
  const scale = Math.min(box!.width / 1280, box!.height / 800);
  // Position inside the unzoomed box, then through the zoom transform.
  const localX = (box!.width - 1280 * scale) / 2 + x * scale;
  const localY = (box!.height - 800 * scale) / 2 + y * scale;
  return {
    x: box!.x + matrix.tx + localX * matrix.s,
    y: box!.y + matrix.ty + localY * matrix.s,
  };
}

type Finger = { x: number; y: number };

async function touch(
  cdp: CDPSession,
  type: "touchStart" | "touchMove" | "touchEnd",
  fingers: Finger[],
): Promise<void> {
  await cdp.send("Input.dispatchTouchEvent", {
    type,
    touchPoints: fingers.map((finger, id) => ({ x: finger.x, y: finger.y, id })),
  });
}

const surface = (page: Page) => page.getByTestId("mobile-agent-browser-surface");
const browserButton = (page: Page) => page.getByTestId("mobile-title-bar-browser");

async function openSurface(page: Page): Promise<void> {
  if ((await surface(page).count()) === 0) await browserButton(page).click();
  await expect(surface(page)).toBeVisible();
}

async function openBrowserView(page: Page, browserId: string): Promise<void> {
  await openSurface(page);
  await page.getByTestId(`mobile-browser-tab-${browserId}`).click();
  await expect(page.getByTestId("mobile-agent-browser")).toHaveAttribute(
    "data-browser-id",
    browserId,
  );
  await expect.poll(() => frames(page)).toBeGreaterThan(0);
}

async function scrollY(page: Page, browserId: string): Promise<number> {
  const snapshot = await agentBrowserSnapshotViaApi(page, browserId);
  return Number(/scrollY:(\d+)/.exec(snapshot)?.[1] ?? -1);
}

test.describe("agent browser on the phone", () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
    await resetMachineState(page);
    await requestMachineControl(page);
  });

  test.afterEach(async ({ page }) => {
    await resetMachineState(page);
  });

  test("lives behind a title-bar button, not in the session switcher", async ({
    page,
  }) => {
    const terminalId = await createTerminalViaApi(page, { cwd: "/root" });
    await expect(getImmersiveTerminal(page)).toBeVisible();
    // No browsers yet: the button is there without a count.
    await expect(browserButton(page)).toBeVisible();
    await expect(page.getByTestId("mobile-title-bar-browser-count")).toHaveCount(0);

    const first = await openAgentBrowserViaApi(page, {
      url: phonePage("First page"),
      openerTerminalId: terminalId,
    });
    const second = await openAgentBrowserViaApi(page, {
      url: phonePage("Second page"),
    });
    await expect(page.getByTestId("mobile-title-bar-browser-count")).toHaveText("2");

    // Not a session: not in the switcher, and the title bar stays the terminal's.
    await page.getByTestId("mobile-title-bar-label").click();
    const switcher = page.getByTestId("mobile-session-switcher");
    await expect(switcher.getByTestId(`mobile-session-row-${terminalId}`)).toBeVisible();
    await expect(switcher.locator("[data-testid^='mobile-session-row-']")).toHaveCount(1);
    await expect(switcher.getByTestId("mobile-session-position")).toHaveText("1/1");
    await page.getByTestId(`mobile-session-row-${terminalId}`).click();

    // The button opens a full-screen surface over the terminal area.
    await browserButton(page).click();
    await expect(surface(page)).toBeVisible();
    const area = await page.getByTestId("mobile-terminal-area").boundingBox();
    const shown = await surface(page).boundingBox();
    expect(Math.round(shown!.width)).toBe(Math.round(area!.width));
    expect(Math.round(shown!.height)).toBe(Math.round(area!.height));
    await expect(page.getByTestId(`mobile-browser-tab-${first.id}`)).toContainText("First page");
    await expect(page.getByTestId(`mobile-browser-tab-${second.id}`)).toContainText("Second page");
    // No duplicate close control in the view itself.
    await expect(page.getByTestId("mobile-agent-browser-close")).toHaveCount(0);

    // Switch between the two tabs; each streams live frames.
    await page.getByTestId(`mobile-browser-tab-${first.id}`).click();
    await expect(page.getByTestId("mobile-agent-browser")).toHaveAttribute(
      "data-browser-id",
      first.id,
    );
    await expect(page.getByTestId("mobile-agent-browser-title")).toHaveText("First page");
    await expect.poll(() => frames(page)).toBeGreaterThan(0);
    const before = await frames(page);
    await expect.poll(() => frames(page)).toBeGreaterThan(before);
    await page.screenshot({ path: "e2e/artifacts/agent-browser-mobile-view.png" });
    await page.getByTestId(`mobile-browser-tab-${second.id}`).click();
    await expect(page.getByTestId("mobile-agent-browser")).toHaveAttribute(
      "data-browser-id",
      second.id,
    );
    await expect(page.getByTestId("mobile-agent-browser-title")).toHaveText("Second page");
    await expect.poll(() => frames(page)).toBeGreaterThan(0);

    // "+" opens an address field; the new page becomes the selected tab.
    await page.getByTestId("mobile-browser-new-tab").click();
    await page.getByTestId("mobile-browser-url-input").fill(phonePage("Third page"));
    await page.getByTestId("mobile-browser-url-submit").click();
    await expect(page.getByTestId("mobile-agent-browser-title")).toHaveText("Third page");
    await expect(page.getByTestId("mobile-title-bar-browser-count")).toHaveText("3");
    await expect(page.getByTestId("mobile-browser-url-input")).toHaveCount(0);
    await expect.poll(() => frames(page)).toBeGreaterThan(0);

    // x closes a tab (here the selected one); another takes over.
    const tabs = page.locator("[data-testid^='mobile-browser-tab-'][role='tab']");
    await expect(tabs).toHaveCount(3);
    await page
      .locator("[role='tab'][data-selected='true'] [data-testid^='mobile-browser-tab-close-']")
      .click();
    await expect(tabs).toHaveCount(2);
    await expect(page.getByTestId("mobile-title-bar-browser-count")).toHaveText("2");
    await expect(page.getByTestId("mobile-agent-browser")).toBeVisible();

    // Back returns to the terminal, which still works.
    await page.getByTestId("mobile-agent-browser-surface-back").click();
    await expect(surface(page)).toHaveCount(0);
    await expect(getImmersiveTerminal(page)).toBeVisible();
    await expect(page.getByTestId("mobile-title-bar-browser-count")).toHaveText("2");
  });

  test("double tap zooms the view locally and taps still land on the right spot", async ({
    page,
  }) => {
    const opened = await openAgentBrowserViaApi(page, { url: phonePage() });
    await openBrowserView(page, opened.id);
    await expect(canvas(page)).toHaveAttribute("data-zoom", "1.00");

    // Double tap on the button (not in control): 2.5x around it.
    const at = await viewportToClient(page, 180, 230);
    await page.touchscreen.tap(at.x, at.y);
    await page.waitForTimeout(60);
    await page.touchscreen.tap(at.x, at.y);
    await expect(canvas(page)).toHaveAttribute("data-zoom", "2.50");
    // The page is untouched by a view-only gesture.
    expect(await agentBrowserSnapshotViaApi(page, opened.id)).toContain("idle");

    // A tap while controlling lands on the button through the zoom.
    await page.getByTestId("mobile-agent-browser-take").click();
    await expect(page.getByTestId("mobile-agent-browser-release")).toBeVisible();
    const zoomed = await viewportToClient(page, 180, 230);
    await page.touchscreen.tap(zoomed.x, zoomed.y);
    await expect
      .poll(() => agentBrowserSnapshotViaApi(page, opened.id))
      .toContain("clicked");

    // Reset zoom from its chip.
    await page.getByTestId("mobile-agent-browser-zoom-reset").click();
    await expect(canvas(page)).toHaveAttribute("data-zoom", "1.00");
  });

  test("pinch zooms and two fingers never reach the page", async ({ page }) => {
    const opened = await openAgentBrowserViaApi(page, { url: phonePage() });
    await openBrowserView(page, opened.id);
    const cdp = await page.context().newCDPSession(page);
    await page.getByTestId("mobile-agent-browser-take").click();
    await expect(page.getByTestId("mobile-agent-browser-release")).toBeVisible();

    const box = (await body(page).boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await touch(cdp, "touchStart", [{ x: cx - 30, y: cy }]);
    await touch(cdp, "touchStart", [
      { x: cx - 30, y: cy },
      { x: cx + 30, y: cy },
    ]);
    for (let step = 1; step <= 6; step += 1) {
      await touch(cdp, "touchMove", [
        { x: cx - 30 - step * 15, y: cy },
        { x: cx + 30 + step * 15, y: cy },
      ]);
    }
    await touch(cdp, "touchEnd", []);
    await expect
      .poll(async () => Number(await canvas(page).getAttribute("data-zoom")))
      .toBeGreaterThan(1.5);
    // Nothing was clicked or scrolled in the page.
    const snapshot = await agentBrowserSnapshotViaApi(page, opened.id);
    expect(snapshot).toContain("idle");
    expect(snapshot).toContain("scrollY:0");
  });

  test("take over: tap, long press, drag to scroll, keyboard and IME, hand back", async ({
    page,
  }) => {
    const opened = await openAgentBrowserViaApi(page, { url: phonePage() });
    await openBrowserView(page, opened.id);
    const cdp = await page.context().newCDPSession(page);

    // Viewing: no key bar, touches do nothing to the page.
    await expect(page.getByTestId("mobile-agent-browser-keybar")).toHaveCount(0);
    await expect(page.getByTestId("mobile-agent-browser-control-state")).toHaveText("Agent");
    const idle = await viewportToClient(page, 180, 230);
    await page.touchscreen.tap(idle.x, idle.y);
    await page.waitForTimeout(300);
    expect(await agentBrowserSnapshotViaApi(page, opened.id)).toContain("idle");

    await page.getByTestId("mobile-agent-browser-take").click();
    await expect(page.getByTestId("mobile-agent-browser-release")).toHaveText("Hand back");
    await expect(page.getByTestId("mobile-agent-browser-control-state")).toHaveText("In control");
    await expect
      .poll(async () => (await getAgentBrowserViaApi(page, opened.id))?.controller)
      .toBe("human");
    await expect(page.getByTestId("mobile-agent-browser-keybar")).toBeVisible();

    // Tap on the mapped button position.
    const button = await viewportToClient(page, 180, 230);
    await page.touchscreen.tap(button.x, button.y);
    await expect
      .poll(() => agentBrowserSnapshotViaApi(page, opened.id))
      .toContain("clicked");

    // Long press = right click.
    const target = await viewportToClient(page, 250, 520);
    await touch(cdp, "touchStart", [target]);
    await page.waitForTimeout(700);
    await touch(cdp, "touchEnd", []);
    await expect
      .poll(() => agentBrowserSnapshotViaApi(page, opened.id))
      .toContain("rightclick");

    // Focus the page's input with a tap then open the
    // keyboard (focus happens inside its tap handler).
    const field = await viewportToClient(page, 300, 320);
    await page.touchscreen.tap(field.x, field.y);
    await page.getByTestId("mobile-agent-browser-keyboard").click();
    await expect(page.getByTestId("mobile-agent-browser-input")).toBeFocused();
    await page.screenshot({ path: "e2e/artifacts/agent-browser-mobile-control.png" });

    // Plain insertText.
    await page.keyboard.insertText("abc");
    await expect
      .poll(() => agentBrowserSnapshotViaApi(page, opened.id))
      .toContain("typed:abc");

    // IME composition: nothing until commit, then exactly one copy.
    await cdp.send("Input.imeSetComposition", {
      text: "你",
      selectionStart: 1,
      selectionEnd: 1,
    });
    await page.waitForTimeout(300);
    expect(await agentBrowserSnapshotViaApi(page, opened.id)).not.toContain("你");
    await cdp.send("Input.insertText", { text: "你" });
    await expect
      .poll(() => agentBrowserSnapshotViaApi(page, opened.id))
      .toContain("typed:abc你");
    await page.waitForTimeout(500);
    const after = await agentBrowserSnapshotViaApi(page, opened.id);
    expect(after).toContain("typed:abc你");
    expect(after).not.toContain("你你");
    expect(after).not.toContain("abcabc");
    expect(
      await page.getByTestId("mobile-agent-browser-input").inputValue(),
    ).toBe("");

    // Key row: Backspace removes the last character.
    await page.getByTestId("mobile-agent-browser-key-Backspace").click();
    await expect
      .poll(() => agentBrowserSnapshotViaApi(page, opened.id))
      .not.toContain("你");
    expect(await agentBrowserSnapshotViaApi(page, opened.id)).toContain("typed:abc");
    // A real Backspace key event (keyCode 8) from a hardware / keyboard-app key.
    await cdp.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "Backspace",
      code: "Backspace",
      windowsVirtualKeyCode: 8,
    });
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Backspace",
      code: "Backspace",
      windowsVirtualKeyCode: 8,
    });
    await expect
      .poll(() => agentBrowserSnapshotViaApi(page, opened.id))
      .toMatch(/typed:ab(?!c)/);

    // One-finger drag up scrolls the page down.
    expect(await scrollY(page, opened.id)).toBe(0);
    const from = await viewportToClient(page, 900, 500);
    await touch(cdp, "touchStart", [from]);
    for (let step = 1; step <= 10; step += 1) {
      await touch(cdp, "touchMove", [{ x: from.x, y: from.y - step * 15 }]);
      await page.waitForTimeout(16);
    }
    await touch(cdp, "touchEnd", []);
    await expect.poll(() => scrollY(page, opened.id)).toBeGreaterThan(200);
    // Native-style: the page moved by roughly the finger distance in page px.
    expect(await scrollY(page, opened.id)).toBeLessThan(800);

    // Hand back.
    await page.getByTestId("mobile-agent-browser-release").click();
    await expect(page.getByTestId("mobile-agent-browser-take")).toBeVisible();
    await expect(page.getByTestId("mobile-agent-browser-keybar")).toHaveCount(0);
    await expect
      .poll(async () => (await getAgentBrowserViaApi(page, opened.id))?.controller)
      .toBe("agent");

    // Close from the tab strip.
    await page.getByTestId(`mobile-browser-tab-close-${opened.id}`).click();
    await expect(page.getByTestId("mobile-agent-browser")).toHaveCount(0);
    await expect(surface(page)).toBeVisible();
    await expect(page.getByTestId("mobile-browser-surface-empty")).toBeVisible();
    await expect.poll(async () => getAgentBrowserViaApi(page, opened.id)).toBeUndefined();
  });

  test("a handoff shows a dot, a toast and an attention entry that opens the tab", async ({
    page,
  }) => {
    const terminalId = await createTerminalViaApi(page, { cwd: "/root" });
    await expect(getImmersiveTerminal(page)).toBeVisible();
    const other = await openAgentBrowserViaApi(page, {
      url: phonePage("Other page"),
      openerTerminalId: terminalId,
    });
    const opened = await openAgentBrowserViaApi(page, {
      url: phonePage("Needs help"),
      openerTerminalId: terminalId,
    });
    const attention = page.getByTestId("mobile-terminal-attention");
    await expect(attention).toHaveCount(0);
    await expect(page.getByTestId("mobile-title-bar-browser-attention")).toHaveCount(0);

    await requestAgentBrowserHandoffViaApi(page, opened.id, "Please log in");
    await expect(page.getByTestId("mobile-title-bar-browser-attention")).toBeVisible();
    await expect(page.getByTestId("workspace-toast")).toContainText(
      "The agent needs you in Needs help: Please log in",
    );
    const chip = page.getByTestId(`mobile-attention-browser-${opened.id}`);
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("Please log in");
    await page.screenshot({ path: "e2e/artifacts/agent-browser-mobile-attention.png" });

    await chip.click();
    await expect(surface(page)).toBeVisible();
    const view = page.getByTestId("mobile-agent-browser");
    await expect(view).toHaveAttribute("data-browser-id", opened.id);
    await expect(page.getByTestId(`mobile-browser-tab-attention-${opened.id}`)).toBeVisible();
    await expect(page.getByTestId("mobile-agent-browser-handoff")).toContainText(
      "The agent needs you: Please log in",
    );
    // Already looking at it: no attention chip any more.
    await expect(attention).toHaveCount(0);
    await page.screenshot({ path: "e2e/artifacts/agent-browser-mobile-handoff.png" });

    await page.getByTestId("mobile-agent-browser-handoff-take").click();
    await expect(page.getByTestId("mobile-agent-browser-handoff-release")).toBeVisible();
    await page.getByTestId("mobile-agent-browser-handoff-release").click();
    await expect(page.getByTestId("mobile-agent-browser-handoff")).toHaveCount(0);
    const record = await getAgentBrowserViaApi(page, opened.id);
    expect(record?.controller).toBe("agent");
    expect(record?.handoff).toBeUndefined();
    await expect(page.getByTestId("mobile-title-bar-browser-attention")).toHaveCount(0);

    // A handoff on the tab that is not showing: its tab strip dot and the chip.
    await requestAgentBrowserHandoffViaApi(page, other.id, "Solve the captcha");
    await expect(page.getByTestId(`mobile-browser-tab-attention-${other.id}`)).toBeVisible();
    await expect(page.getByTestId(`mobile-attention-browser-${other.id}`)).toBeVisible();

    await closeAgentBrowserViaApi(page, opened.id);
    await closeAgentBrowserViaApi(page, other.id);
    await expect(page.getByTestId("mobile-agent-browser")).toHaveCount(0);
    await page.getByTestId("mobile-agent-browser-surface-back").click();
    await expect(getImmersiveTerminal(page)).toBeVisible();
  });

  test("a machine with no terminals still opens its browser from the title bar", async ({
    page,
  }) => {
    const opened = await openAgentBrowserViaApi(page, { url: phonePage("Lonely") });
    await expect(page.getByTestId("mobile-agent-browser-surface")).toHaveCount(0);
    await expect(browserButton(page)).toBeVisible();
    await expect(page.getByTestId("mobile-title-bar-browser-count")).toHaveText("1");
    await browserButton(page).click();
    await expect(page.getByTestId("mobile-agent-browser")).toHaveAttribute(
      "data-browser-id",
      opened.id,
    );
    await expect.poll(() => frames(page)).toBeGreaterThan(0);
  });
});
