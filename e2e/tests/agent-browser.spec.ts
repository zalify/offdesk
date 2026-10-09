import { expect, test, type Page } from "@playwright/test";

import {
  agentBrowserSnapshotViaApi,
  closeAgentBrowserViaApi,
  controlAgentBrowserViaApi,
  createTerminalViaApi,
  getAgentBrowserViaApi,
  getDeviceId,
  gotoAgentBrowserViaApi,
  listAgentBrowsersViaApi,
  openAgentBrowserViaApi,
  openApp,
  reclaimAgentBrowserViaApi,
  requestAgentBrowserHandoffViaApi,
  resetMachineState,
  takeControlFromHeader,
  tryAgentBrowserCommand,
} from "./helpers";

// A page whose background animates, so consecutive frames differ and the
// screencast keeps producing them.
function animatedPage(title: string): string {
  const html =
    `<title>${title}</title>` +
    "<style>@keyframes pulse{from{background:#c00}to{background:#00c}}" +
    "body{margin:0;height:100vh;animation:pulse .5s infinite alternate}" +
    "h1{color:#fff;font:48px sans-serif}</style>" +
    `<h1>${title}</h1>`;
  return `data:text/html,${encodeURIComponent(html)}`;
}

// Absolutely positioned widgets so the test knows where to click in the
// 1280x800 viewport: input (100,300) 300x30, button (100,200) 120x40.
function formPage(): string {
  const html =
    "<title>Form page</title>" +
    "<body style='margin:0;font:16px sans-serif'>" +
    "<input id=i aria-label=Name style='position:absolute;left:100px;top:300px;" +
    "width:300px;height:30px;box-sizing:border-box' " +
    "oninput=\"o.textContent='typed:'+this.value\">" +
    "<button id=b style='position:absolute;left:100px;top:200px;width:120px;height:40px' " +
    "onclick=\"c.textContent='clicked'\">Go</button>" +
    "<div id=o style='position:absolute;left:100px;top:400px'>typed:</div>" +
    "<div id=c style='position:absolute;left:100px;top:450px'>idle</div>" +
    "<div id=k style='position:absolute;left:100px;top:500px'>key:none</div>" +
    "<script>addEventListener('keydown',e=>{k.textContent='key:'+e.key})</script>";
  return `data:text/html,${encodeURIComponent(html)}`;
}

// Each load writes a new stamp, so a reload shows in the snapshot.
function stampedPage(title: string): string {
  const html =
    `<title>${title}</title><body style='margin:0;font:16px sans-serif'>` +
    `<h1>${title}</h1><p id=s></p>` +
    "<script>s.textContent='stamp:'+Math.random().toString(36).slice(2)</script>";
  return `data:text/html,${encodeURIComponent(html)}`;
}

// Buttons at known spots (160x40): confirm (100,200), prompt (100,300).
function dialogPage(): string {
  const button = (top: number, label: string, onclick: string) =>
    `<button style='position:absolute;left:100px;top:${top}px;width:160px;height:40px' ` +
    `onclick="${onclick}">${label}</button>`;
  const html =
    "<title>Dialog page</title><body style='margin:0;font:16px sans-serif'>" +
    button(200, "Confirm", "o.textContent='confirm:'+confirm('Sure?')") +
    button(300, "Prompt", "o.textContent='prompt:'+prompt('Name?','x')") +
    "<div id=o style='position:absolute;left:100px;top:500px'>none</div>";
  return `data:text/html,${encodeURIComponent(html)}`;
}

// A button (100,200 160x40) that opens a window with a "Close me" button at
// the same spot, which closes it again.
function popupPage(): string {
  const popup =
    "<title>Popup page</title><button style=\"position:absolute;left:100px;top:200px;" +
    "width:160px;height:40px\" onclick=\"window.close()\">Close me</button>";
  const html =
    "<title>Opener page</title><body style='margin:0;font:16px sans-serif'>" +
    "<button id=b style='position:absolute;left:100px;top:200px;width:160px;height:40px'>Open</button>" +
    `<script>b.onclick=()=>{const w=window.open('');w.document.write(${JSON.stringify(popup)});w.document.close()}</script>`;
  return `data:text/html,${encodeURIComponent(html)}`;
}

/** Client coordinates of a 1280x800 viewport point on the letterboxed canvas. */
async function viewportToClient(
  page: Page,
  browserId: string,
  x: number,
  y: number,
): Promise<{ x: number; y: number }> {
  const box = await page
    .getByTestId(`agent-browser-pane-${browserId}`)
    .getByTestId("agent-browser-canvas")
    .boundingBox();
  expect(box).toBeTruthy();
  const scale = Math.min(box!.width / 1280, box!.height / 800);
  const left = box!.x + (box!.width - 1280 * scale) / 2;
  const top = box!.y + (box!.height - 800 * scale) / 2;
  return { x: left + x * scale, y: top + y * scale };
}

async function openOverlay(page: Page) {
  await page.getByTestId("tab-bar-browser").click();
  await expect(page.getByTestId("agent-browser-overlay")).toBeVisible();
}

async function frames(page: Page, browserId: string): Promise<number> {
  const value = await page
    .getByTestId(`agent-browser-pane-${browserId}`)
    .getByTestId("agent-browser-canvas")
    .getAttribute("data-frames");
  return Number(value ?? 0);
}

/** Live agent-browser viewer sockets of this page. */
function trackViewerSockets(page: Page): { open: () => number } {
  const live = new Set<unknown>();
  page.on("websocket", (ws) => {
    if (!ws.url().includes("/ws/agent-browser/")) return;
    live.add(ws);
    ws.on("close", () => live.delete(ws));
  });
  return { open: () => live.size };
}

test.describe("agent browser", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 960 });
    await openApp(page);
    await resetMachineState(page);
    await takeControlFromHeader(page);
  });

  test.afterEach(async ({ page }) => {
    await resetMachineState(page);
  });

  test("browsers stay out of the workspace; the top-bar button opens them in an overlay", async ({
    page,
  }) => {
    const sockets = trackViewerSockets(page);
    const terminalId = await createTerminalViaApi(page, { cwd: "/root" });
    await expect(page.getByTestId(`workspace-pane-${terminalId}`)).toBeVisible();
    const tabsBefore = await page.locator("[data-testid^='workspace-group-']").count();

    const button = page.getByTestId("tab-bar-browser");
    await expect(button).toBeVisible();
    await expect(page.getByTestId("tab-bar-browser-count")).toHaveCount(0);

    // Opened from the terminal, yet it is not a pane or a tab of the workspace.
    const opened = await openAgentBrowserViaApi(page, {
      url: animatedPage("Alpha page"),
      openerTerminalId: terminalId,
    });
    await expect(page.getByTestId("tab-bar-browser-count")).toHaveText("1");
    await expect(page.getByTestId(`agent-browser-pane-${opened.id}`)).toHaveCount(0);
    await expect(page.locator("[data-testid^='workspace-group-']")).toHaveCount(tabsBefore);
    await expect(page.locator("[data-testid^='workspace-tab-attention-']")).toHaveCount(0);
    expect(sockets.open()).toBe(0);

    await openOverlay(page);
    const tab = page.getByTestId(`agent-browser-tab-${opened.id}`);
    await expect(tab).toHaveAttribute("data-selected", "true");
    await expect(tab).toContainText("Alpha page");
    const pane = page.getByTestId(`agent-browser-pane-${opened.id}`);
    await expect(pane.getByTestId("agent-browser-control-state")).toHaveText(
      "Agent in control",
    );
    await expect(pane.getByTestId("agent-browser-state")).toHaveText("Live");
    // The terminal underneath stays mounted.
    await expect(page.getByTestId(`workspace-pane-${terminalId}`)).toBeAttached();

    // Frames keep arriving, and they are real pixels.
    await expect.poll(() => frames(page, opened.id)).toBeGreaterThan(0);
    const before = await frames(page, opened.id);
    await page.waitForTimeout(2000);
    expect(await frames(page, opened.id)).toBeGreaterThan(before);
    const nonBlank = await pane
      .getByTestId("agent-browser-canvas")
      .evaluate((node) => {
        const canvas = node as HTMLCanvasElement;
        const data = canvas
          .getContext("2d")!
          .getImageData(0, 0, canvas.width, canvas.height).data;
        let lit = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] > 20 || data[i + 1] > 20 || data[i + 2] > 20) lit += 1;
        }
        return lit / (data.length / 4);
      });
    expect(nonBlank).toBeGreaterThan(0.5);
    expect(sockets.open()).toBe(1);
    await page.screenshot({ path: "e2e/artifacts/agent-browser-overlay-viewing.png" });

    // Navigation updates the tab.
    await gotoAgentBrowserViaApi(page, opened.id, animatedPage("Beta page"));
    await expect(tab).toContainText("Beta page");

    // Not in control: Esc closes the overlay and the stream stops.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("agent-browser-overlay")).toHaveCount(0);
    await expect.poll(() => sockets.open()).toBe(0);
    await expect(page.getByTestId(`workspace-pane-${terminalId}`)).toBeVisible();

    // The button opens it; the backdrop and the close button close it.
    await button.click();
    await expect(page.getByTestId("agent-browser-overlay")).toBeVisible();
    await expect(button).toHaveAttribute("data-open", "true");
    // The backdrop covers the top bar, so this click lands on the backdrop.
    await button.click({ force: true });
    await expect(page.getByTestId("agent-browser-overlay")).toHaveCount(0);
    await expect(button).toHaveAttribute("data-open", "false");
    await button.click();
    await page
      .getByTestId("agent-browser-overlay-backdrop")
      .click({ position: { x: 5, y: 5 } });
    await expect(page.getByTestId("agent-browser-overlay")).toHaveCount(0);
    await button.click();
    await page.getByTestId("agent-browser-overlay-close").click();
    await expect(page.getByTestId("agent-browser-overlay")).toHaveCount(0);
  });

  test("tabs: the selection is remembered and closing a tab closes the browser", async ({
    page,
  }) => {
    const first = await openAgentBrowserViaApi(page, { url: animatedPage("First page") });
    const second = await openAgentBrowserViaApi(page, { url: animatedPage("Second page") });
    await expect(page.getByTestId("tab-bar-browser-count")).toHaveText("2");

    await openOverlay(page);
    await page.getByTestId(`agent-browser-tab-${second.id}`).click();
    await expect(page.getByTestId(`agent-browser-pane-${second.id}`)).toBeVisible();
    // Only the selected tab is mounted.
    await expect(page.getByTestId(`agent-browser-pane-${first.id}`)).toHaveCount(0);
    await page.keyboard.press("Escape");

    await openOverlay(page);
    await expect(page.getByTestId(`agent-browser-tab-${second.id}`)).toHaveAttribute(
      "data-selected",
      "true",
    );

    // Closing the selected tab selects the one left.
    await page.getByTestId(`agent-browser-tab-close-${second.id}`).click();
    await expect(page.getByTestId(`agent-browser-tab-${second.id}`)).toHaveCount(0);
    await expect(page.getByTestId(`agent-browser-tab-${first.id}`)).toHaveAttribute(
      "data-selected",
      "true",
    );
    await expect(page.getByTestId(`agent-browser-pane-${first.id}`)).toBeVisible();
    expect(await getAgentBrowserViaApi(page, second.id)).toBeUndefined();

    // Closed through the API: the empty state.
    await closeAgentBrowserViaApi(page, first.id);
    await expect(page.getByTestId("agent-browser-overlay-empty")).toHaveText(
      "No browser tabs on this machine",
    );
    await expect(page.getByTestId("agent-browser-url-input")).toBeVisible();
  });

  test("the + button opens a page by address and selects the new tab", async ({
    page,
  }) => {
    await openOverlay(page);
    await expect(page.getByTestId("agent-browser-overlay-empty")).toHaveText(
      "No browser tabs on this machine",
    );

    // Nothing usable: an inline error, nothing opened.
    await page.getByTestId("agent-browser-url-input").fill("not a url");
    await page.getByTestId("agent-browser-url-input").press("Enter");
    await expect(page.getByTestId("agent-browser-overlay-error")).toBeVisible();

    await page.getByTestId("agent-browser-url-input").fill(animatedPage("Typed page"));
    await page.getByTestId("agent-browser-url-input").press("Enter");
    const tab = page.getByRole("tab");
    await expect(tab).toHaveCount(1);
    await expect(tab.first()).toContainText("Typed page");
    await expect(tab.first()).toHaveAttribute("data-selected", "true");
    await expect(page.getByTestId("agent-browser-url-input")).toHaveCount(0);
    const browserId = (await tab.first().getAttribute("data-testid"))!.replace(
      "agent-browser-tab-",
      "",
    );
    await expect.poll(() => frames(page, browserId)).toBeGreaterThan(0);
    expect((await getAgentBrowserViaApi(page, browserId))?.title).toBe("Typed page");

    // "+" with tabs open: a second tab, selected when it arrives. Esc in the
    // field folds it away without closing the overlay.
    await page.getByTestId("agent-browser-new-tab").click();
    await page.getByTestId("agent-browser-url-input").press("Escape");
    await expect(page.getByTestId("agent-browser-url-input")).toHaveCount(0);
    await expect(page.getByTestId("agent-browser-overlay")).toBeVisible();
    await page.getByTestId("agent-browser-new-tab").click();
    await page.getByTestId("agent-browser-url-input").fill(animatedPage("Second typed"));
    await page.getByTestId("agent-browser-url-input").press("Enter");
    await expect(tab).toHaveCount(2);
    await expect(tab.last()).toHaveAttribute("data-selected", "true");
    await expect(tab.last()).toContainText("Second typed");
  });

  test("a person takes over, types, clicks and presses Esc in the page, then hands back", async ({
    page,
  }) => {
    const opened = await openAgentBrowserViaApi(page, { url: formPage() });
    await openOverlay(page);
    const pane = page.getByTestId(`agent-browser-pane-${opened.id}`);
    await expect(pane).toBeVisible();
    await expect.poll(() => frames(page, opened.id)).toBeGreaterThan(0);
    await expect(pane.getByTestId("agent-browser-take")).toHaveText("Take over");

    await pane.getByTestId("agent-browser-take").click();
    await expect(pane.getByTestId("agent-browser-release")).toHaveText("Hand back");
    await expect(pane.getByTestId("agent-browser-control-state")).toHaveText(
      "You're in control",
    );
    await expect(page.getByTestId(`agent-browser-tab-you-${opened.id}`)).toBeVisible();
    const deviceId = await getDeviceId(page);
    await expect
      .poll(async () => (await getAgentBrowserViaApi(page, opened.id))?.controller)
      .toBe("human");
    expect(
      (await getAgentBrowserViaApi(page, opened.id))?.controller_device_id,
    ).toBe(deviceId);

    const input = await viewportToClient(page, opened.id, 250, 315);
    await page.mouse.click(input.x, input.y);
    await page.keyboard.type("bob");
    await expect
      .poll(() => agentBrowserSnapshotViaApi(page, opened.id))
      .toContain("typed:bob");

    const button = await viewportToClient(page, opened.id, 160, 220);
    await page.mouse.click(button.x, button.y);
    await expect
      .poll(() => agentBrowserSnapshotViaApi(page, opened.id))
      .toContain("clicked");

    // Esc belongs to the page while in control: the overlay stays open.
    await page.keyboard.press("Escape");
    await expect
      .poll(() => agentBrowserSnapshotViaApi(page, opened.id))
      .toContain("key:Escape");
    await expect(page.getByTestId("agent-browser-overlay")).toBeVisible();
    await page.screenshot({ path: "e2e/artifacts/agent-browser-overlay-control.png" });

    // The agent may not act while a person is in control.
    const refused = await tryAgentBrowserCommand(page, {
      type: "click",
      browser_id: opened.id,
      ref: "e1",
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("user_in_control");

    await pane.getByTestId("agent-browser-release").click();
    await expect(pane.getByTestId("agent-browser-take")).toBeVisible();
    await expect
      .poll(async () => (await getAgentBrowserViaApi(page, opened.id))?.controller)
      .toBe("agent");
    // Handed back: Esc closes the overlay again.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("agent-browser-overlay")).toHaveCount(0);
  });

  test("the toolbar goes back and forward, reloads, loads a typed address and has shortcuts", async ({
    page,
  }) => {
    const opened = await openAgentBrowserViaApi(page, { url: stampedPage("One") });
    await gotoAgentBrowserViaApi(page, opened.id, stampedPage("Two"));
    const title = async () => (await getAgentBrowserViaApi(page, opened.id))?.title;
    await openOverlay(page);
    const pane = page.getByTestId(`agent-browser-pane-${opened.id}`);
    await expect.poll(() => frames(page, opened.id)).toBeGreaterThan(0);
    const back = pane.getByTestId("agent-browser-back");
    const forward = pane.getByTestId("agent-browser-forward");
    const address = pane.getByTestId("agent-browser-address");

    // While the agent drives, the toolbar stays off.
    await expect(back).toBeDisabled();
    await expect(back).toHaveAttribute("title", "Take over to navigate");
    await expect(address).toHaveAttribute("readonly", "");
    await pane.getByTestId("agent-browser-take").click();
    await expect(back).toBeEnabled();
    await expect(forward).toBeDisabled();

    await back.click();
    await expect.poll(title).toBe("One");
    // The blank page a tab starts on is not somewhere to go back to.
    await expect(back).toBeDisabled();
    await expect(forward).toBeEnabled();
    await forward.click();
    await expect.poll(title).toBe("Two");

    // Reload runs the page again: a new stamp.
    const stamp = async () =>
      /stamp:\w+/.exec(await agentBrowserSnapshotViaApi(page, opened.id))?.[0];
    const before = await stamp();
    expect(before).toBeTruthy();
    await pane.getByTestId("agent-browser-reload").click();
    await expect.poll(stamp).not.toBe(before);

    // The address bar: the whole URL to edit, Enter loads it and gives the
    // keyboard back to the page.
    await address.click();
    await expect(address).toHaveValue(/^data:text\/html,/);
    await address.fill(stampedPage("Three"));
    await address.press("Enter");
    await expect.poll(title).toBe("Three");
    await expect(pane.getByTestId("agent-browser-input")).toBeFocused();

    // Browser shortcuts go to the toolbar (Chrome's Linux ones here).
    await page.keyboard.press("Alt+ArrowLeft");
    await expect.poll(title).toBe("Two");
    await page.keyboard.press("Alt+ArrowRight");
    await expect.poll(title).toBe("Three");
    await page.keyboard.press("Control+l");
    await expect(address).toBeFocused();
    // Esc leaves the field and keeps the overlay open.
    await page.keyboard.press("Escape");
    await expect(address).not.toBeFocused();
    await expect(page.getByTestId("agent-browser-overlay")).toBeVisible();
    await page.screenshot({ path: "e2e/artifacts/agent-browser-toolbar.png" });
  });

  test("a page's dialogs show over it; the person in control answers them, the agent can too", async ({
    page,
  }) => {
    const opened = await openAgentBrowserViaApi(page, { url: dialogPage() });
    await openOverlay(page);
    const pane = page.getByTestId(`agent-browser-pane-${opened.id}`);
    await expect.poll(() => frames(page, opened.id)).toBeGreaterThan(0);
    await pane.getByTestId("agent-browser-take").click();
    await expect(pane.getByTestId("agent-browser-release")).toBeVisible();
    const output = () => agentBrowserSnapshotViaApi(page, opened.id);

    const confirmButton = await viewportToClient(page, opened.id, 180, 220);
    await page.mouse.click(confirmButton.x, confirmButton.y);
    const dialog = pane.getByTestId("agent-browser-dialog");
    await expect(dialog).toHaveAttribute("data-kind", "confirm");
    await expect(pane.getByTestId("agent-browser-dialog-message")).toHaveText("Sure?");
    await page.screenshot({ path: "e2e/artifacts/agent-browser-dialog.png" });
    // The agent cannot read the page meanwhile, and is told why.
    const refused = await tryAgentBrowserCommand(page, {
      type: "snapshot",
      browser_id: opened.id,
    });
    expect(refused.status).toBe(422);
    expect(String(refused.body.error)).toContain('a confirm dialog ("Sure?")');
    await pane.getByTestId("agent-browser-dialog-dismiss").click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(output).toContain("confirm:false");

    // A prompt comes prefilled and takes the keyboard; Enter answers it.
    const promptButton = await viewportToClient(page, opened.id, 180, 320);
    await page.mouse.click(promptButton.x, promptButton.y);
    const input = pane.getByTestId("agent-browser-dialog-input");
    await expect(input).toHaveValue("x");
    await expect(input).toBeFocused();
    await input.fill("Ada");
    await input.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect.poll(output).toContain("prompt:Ada");

    // The agent's click that opens a dialog returns with it; the person sees
    // it but the agent, in control, answers.
    await pane.getByTestId("agent-browser-release").click();
    await expect(pane.getByTestId("agent-browser-take")).toBeVisible();
    const clicked = await tryAgentBrowserCommand(page, {
      type: "click",
      browser_id: opened.id,
      text: "Confirm",
    });
    expect(clicked.status).toBe(200);
    expect((clicked.body.dialog as { message?: string } | undefined)?.message).toBe("Sure?");
    await expect(pane.getByTestId("agent-browser-dialog-hint")).toHaveText(
      "Take over to answer",
    );
    await expect(pane.getByTestId("agent-browser-dialog-accept")).toBeDisabled();
    const answered = await tryAgentBrowserCommand(page, {
      type: "dialog",
      browser_id: opened.id,
      accept: true,
    });
    expect(answered.status).toBe(200);
    await expect(dialog).toHaveCount(0);
    await expect.poll(output).toContain("confirm:true");
  });

  test("a window the page opens comes up as a tab in your control; closing it returns you", async ({
    page,
  }) => {
    const opened = await openAgentBrowserViaApi(page, { url: popupPage() });
    await openOverlay(page);
    const pane = page.getByTestId(`agent-browser-pane-${opened.id}`);
    await expect.poll(() => frames(page, opened.id)).toBeGreaterThan(0);
    await pane.getByTestId("agent-browser-take").click();
    await expect(pane.getByTestId("agent-browser-release")).toBeVisible();

    const open = await viewportToClient(page, opened.id, 180, 220);
    await page.mouse.click(open.x, open.y);
    let popupId = "";
    await expect
      .poll(async () => {
        const popup = (await listAgentBrowsersViaApi(page)).find(
          (browser) => browser.opener_browser_id === opened.id,
        );
        popupId = popup?.id ?? "";
        return popupId;
      })
      .not.toBe("");
    const popupTab = page.getByTestId(`agent-browser-tab-${popupId}`);
    await expect(popupTab).toHaveAttribute("data-selected", "true");
    await expect(popupTab).toContainText("Popup page");
    await expect(page.getByTestId(`agent-browser-tab-you-${popupId}`)).toBeVisible();
    const deviceId = await getDeviceId(page);
    await expect
      .poll(async () => (await getAgentBrowserViaApi(page, popupId))?.controller_device_id)
      .toBe(deviceId);
    await expect.poll(() => frames(page, popupId)).toBeGreaterThan(0);
    await page.screenshot({ path: "e2e/artifacts/agent-browser-popup.png" });

    const close = await viewportToClient(page, popupId, 180, 220);
    await page.mouse.click(close.x, close.y);
    await expect(popupTab).toHaveCount(0);
    await expect(page.getByTestId(`agent-browser-tab-${opened.id}`)).toHaveAttribute(
      "data-selected",
      "true",
    );
    expect(await getAgentBrowserViaApi(page, popupId)).toBeUndefined();
  });

  test("a handoff toasts, marks the button, and the button opens that tab", async ({
    page,
  }) => {
    const quiet = await openAgentBrowserViaApi(page, { url: animatedPage("Quiet page") });
    const opened = await openAgentBrowserViaApi(page, { url: formPage() });
    await expect(page.getByTestId("tab-bar-browser-count")).toHaveText("2");
    await expect(page.getByTestId("tab-bar-browser-attention")).toHaveCount(0);

    await requestAgentBrowserHandoffViaApi(page, opened.id, "Please log in");
    await expect(page.getByTestId("workspace-toast")).toHaveText(
      "The agent needs you in Form page: Please log in",
    );
    const attention = page.getByTestId("tab-bar-browser-attention");
    await expect(attention).toBeVisible();
    await expect(page.getByTestId("tab-bar-browser")).toHaveAttribute(
      "title",
      "The agent needs you",
    );

    // Opens on the tab that needs you, not the first one.
    await openOverlay(page);
    await expect(page.getByTestId(`agent-browser-tab-${opened.id}`)).toHaveAttribute(
      "data-selected",
      "true",
    );
    await expect(page.getByTestId(`agent-browser-tab-${quiet.id}`)).toHaveAttribute(
      "data-selected",
      "false",
    );
    await expect(
      page.getByTestId(`agent-browser-tab-attention-${opened.id}`),
    ).toBeVisible();
    const pane = page.getByTestId(`agent-browser-pane-${opened.id}`);
    const banner = pane.getByTestId("agent-browser-handoff");
    await expect(banner).toContainText("The agent needs you: Please log in");
    await expect.poll(() => frames(page, opened.id)).toBeGreaterThan(0);
    await page.screenshot({ path: "e2e/artifacts/agent-browser-overlay-handoff.png" });

    // Taking over from the banner settles the dots; handing back clears it.
    await banner.getByTestId("agent-browser-handoff-take").click();
    await expect(banner.getByTestId("agent-browser-handoff-release")).toBeVisible();
    await expect(attention).toHaveCount(0);
    await banner.getByTestId("agent-browser-handoff-release").click();
    await expect(banner).toHaveCount(0);
    const record = await getAgentBrowserViaApi(page, opened.id);
    expect(record?.controller).toBe("agent");
    expect(record?.handoff).toBeUndefined();
  });

  test("the agent taking control back is announced and stops the pane's input", async ({
    page,
  }) => {
    const opened = await openAgentBrowserViaApi(page, { url: formPage() });
    await openOverlay(page);
    const pane = page.getByTestId(`agent-browser-pane-${opened.id}`);
    const header = pane.getByTestId("agent-browser-control-state");
    const notice = pane.getByTestId("agent-browser-reclaimed");
    await expect.poll(() => frames(page, opened.id)).toBeGreaterThan(0);

    // Taken over but untouched: the agent may take it back right away.
    await pane.getByTestId("agent-browser-take").click();
    await expect(header).toHaveText("You're in control");
    await expect(pane.getByTestId("agent-browser-input")).toBeFocused();
    await expect(notice).toHaveCount(0);
    const first = await reclaimAgentBrowserViaApi(page, opened.id, {
      reason: "Checking the page myself",
    });
    expect(first.status).toBe(200);
    await expect(header).toHaveText("Agent in control");
    await expect(notice).toBeVisible();
    await expect(pane.getByTestId("agent-browser-reclaimed-reason")).toHaveText(
      "The agent took control back from you: Checking the page myself",
    );
    await expect(pane.getByTestId("agent-browser-input")).not.toBeFocused();
    await page.screenshot({ path: "e2e/artifacts/agent-browser-overlay-reclaimed.png" });

    // No longer in control: a click on the page does nothing.
    const button = await viewportToClient(page, opened.id, 160, 220);
    await page.mouse.click(button.x, button.y);
    await page.waitForTimeout(500);
    expect(await agentBrowserSnapshotViaApi(page, opened.id)).toContain("idle");

    // Dismissing hides the notice.
    await pane.getByTestId("agent-browser-reclaimed-dismiss").click();
    await expect(notice).toHaveCount(0);

    // Taking over again clears the reclaim; a click is recorded as activity.
    await pane.getByTestId("agent-browser-take").click();
    await expect(header).toHaveText("You're in control");
    await expect(notice).toHaveCount(0);
    await expect
      .poll(async () => (await getAgentBrowserViaApi(page, opened.id))?.reclaimed)
      .toBeUndefined();
    // The notice is gone, so the page area moved: map the point again.
    const again = await viewportToClient(page, opened.id, 160, 220);
    await page.mouse.click(again.x, again.y);
    await expect
      .poll(() => agentBrowserSnapshotViaApi(page, opened.id))
      .toContain("clicked");

    // The person just acted: refused unless forced.
    const refused = await reclaimAgentBrowserViaApi(page, opened.id, {
      reason: "Need the page",
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("user_active");
    expect(Number(refused.body.retry_after_ms)).toBeGreaterThan(0);
    await expect(header).toHaveText("You're in control");
    await expect(notice).toHaveCount(0);

    const forced = await reclaimAgentBrowserViaApi(page, opened.id, {
      reason: "Need the page",
      force: true,
    });
    expect(forced.status).toBe(200);
    await expect(header).toHaveText("Agent in control");
    await expect(pane.getByTestId("agent-browser-reclaimed-reason")).toHaveText(
      "The agent took control back from you: Need the page",
    );

    // Reopening the overlay does not replay the stale record.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("agent-browser-overlay")).toHaveCount(0);
    await openOverlay(page);
    await expect(
      page.getByTestId(`agent-browser-pane-${opened.id}`).getByTestId("agent-browser-header"),
    ).toBeVisible();
    await expect(page.getByTestId("agent-browser-reclaimed")).toHaveCount(0);
  });

  test("a reclaim while the overlay is closed toasts the person who lost control", async ({
    page,
  }) => {
    const opened = await openAgentBrowserViaApi(page, { url: formPage() });
    await openOverlay(page);
    const pane = page.getByTestId(`agent-browser-pane-${opened.id}`);
    await pane.getByTestId("agent-browser-take").click();
    await expect(pane.getByTestId("agent-browser-release")).toBeVisible();
    await page.getByTestId("agent-browser-overlay-close").click();
    await expect(page.getByTestId("agent-browser-overlay")).toHaveCount(0);

    const result = await reclaimAgentBrowserViaApi(page, opened.id, {
      reason: "Back to me",
    });
    expect(result.status).toBe(200);
    await expect(page.getByTestId("workspace-toast")).toHaveText(
      "The agent took control back from you: Back to me",
    );
  });

  test("another device's control is shown and can be taken over", async ({
    page,
  }) => {
    const opened = await openAgentBrowserViaApi(page, { url: formPage() });
    await openOverlay(page);
    const pane = page.getByTestId(`agent-browser-pane-${opened.id}`);
    await expect(pane).toBeVisible();
    await controlAgentBrowserViaApi(page, opened.id, {
      action: "take",
      device_id: "some-other-device",
    });
    await expect(pane.getByTestId("agent-browser-control-state")).toHaveText(
      "Controlled on another device",
    );
    await pane.getByTestId("agent-browser-take").click();
    await expect(pane.getByTestId("agent-browser-control-state")).toHaveText(
      "You're in control",
    );
  });
});
