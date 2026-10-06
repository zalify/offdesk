import { expect, test, type Page } from "@playwright/test";

import {
  agentBrowserSnapshotViaApi,
  closeAgentBrowserViaApi,
  controlAgentBrowserViaApi,
  createTerminalViaApi,
  getAgentBrowserViaApi,
  getDeviceId,
  gotoAgentBrowserViaApi,
  openAgentBrowserViaApi,
  openApp,
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
    "<div id=c style='position:absolute;left:100px;top:450px'>idle</div>";
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

function workspaceGroup(page: Page, label: string) {
  return page
    .locator("[data-testid^='workspace-group-']")
    .filter({ hasText: label })
    .last();
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

  test("streams live into the opener terminal's tab and follows navigation", async ({
    page,
  }) => {
    const terminalId = await createTerminalViaApi(page, { cwd: "/root" });
    await expect(page.getByTestId(`workspace-pane-${terminalId}`)).toBeVisible();

    const opened = await openAgentBrowserViaApi(page, {
      url: animatedPage("Alpha page"),
      openerTerminalId: terminalId,
    });
    const pane = page.getByTestId(`agent-browser-pane-${opened.id}`);
    await expect(pane).toBeVisible();
    // Same tab as the terminal: both panes are on screen together.
    await expect(page.getByTestId(`workspace-pane-${terminalId}`)).toBeVisible();
    await expect(pane.getByTestId("agent-browser-title")).toHaveText("Alpha page");
    await expect(pane.getByTestId("agent-browser-control-state")).toHaveText(
      "Agent in control",
    );
    await expect(pane.getByTestId("agent-browser-state")).toHaveText("Live");

    // Frames keep arriving over time.
    await expect.poll(() => frames(page, opened.id)).toBeGreaterThan(0);
    const before = await frames(page, opened.id);
    await page.waitForTimeout(2000);
    expect(await frames(page, opened.id)).toBeGreaterThan(before);

    // The canvas holds real pixels, not a blank (all-transparent/black) frame.
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
    await page.screenshot({ path: "e2e/artifacts/agent-browser-pane.png" });

    // Navigating updates the header.
    await gotoAgentBrowserViaApi(page, opened.id, animatedPage("Beta page"));
    await expect(pane.getByTestId("agent-browser-title")).toHaveText("Beta page");

    // The pane's close button closes the browser.
    await pane.getByTestId("agent-browser-close").click();
    await expect(pane).toHaveCount(0);
    await expect(page.getByTestId(`workspace-pane-${terminalId}`)).toBeVisible();
  });

  test("a browser without an opener gets its own tab and streams only while shown", async ({
    page,
  }) => {
    const sockets = trackViewerSockets(page);
    const terminalId = await createTerminalViaApi(page, { cwd: "/root" });
    await expect(page.getByTestId(`workspace-pane-${terminalId}`)).toBeVisible();

    const opened = await openAgentBrowserViaApi(page, {
      url: animatedPage("Solo page"),
    });
    const pane = page.getByTestId(`agent-browser-pane-${opened.id}`);
    const tab = workspaceGroup(page, "Solo page");
    await expect(tab).toBeVisible();

    // Opening does not steal focus; open the browser's tab.
    await tab.click();
    await expect(pane).toBeVisible();
    await expect.poll(() => frames(page, opened.id)).toBeGreaterThan(0);
    expect(sockets.open()).toBe(1);

    // Switch to the terminal's tab: the hidden pane holds no socket and its
    // frame counter stops.
    await workspaceGroup(page, "root").click();
    await expect.poll(() => sockets.open()).toBe(0);
    const hiddenFrames = await pane.count() ? await frames(page, opened.id) : 0;
    await page.waitForTimeout(1500);
    const stillHidden = await pane.count() ? await frames(page, opened.id) : 0;
    expect(stillHidden).toBe(hiddenFrames);

    // Back again: streaming resumes.
    await tab.click();
    await expect(pane).toBeVisible();
    await expect.poll(() => sockets.open()).toBe(1);
    const resumedFrom = await frames(page, opened.id);
    await expect
      .poll(() => frames(page, opened.id))
      .toBeGreaterThan(resumedFrom);

    // Closing through the API removes the browser's own tab.
    await closeAgentBrowserViaApi(page, opened.id);
    await expect(tab).toHaveCount(0);
    await expect(pane).toHaveCount(0);
  });

  test("a machine with only an agent browser still shows it", async ({
    page,
  }) => {
    const opened = await openAgentBrowserViaApi(page, {
      url: animatedPage("Lonely page"),
    });
    const pane = page.getByTestId(`agent-browser-pane-${opened.id}`);
    await expect(pane).toBeVisible();
    await expect.poll(() => frames(page, opened.id)).toBeGreaterThan(0);
  });
  test("a person takes over, types and clicks, then hands back", async ({
    page,
  }) => {
    const opened = await openAgentBrowserViaApi(page, { url: formPage() });
    const pane = page.getByTestId(`agent-browser-pane-${opened.id}`);
    await expect(pane).toBeVisible();
    await expect.poll(() => frames(page, opened.id)).toBeGreaterThan(0);
    await expect(pane.getByTestId("agent-browser-take")).toHaveText("Take over");

    await pane.getByTestId("agent-browser-take").click();
    await expect(pane.getByTestId("agent-browser-release")).toHaveText(
      "Hand back",
    );
    await expect(pane.getByTestId("agent-browser-control-state")).toHaveText(
      "You're in control",
    );
    const deviceId = await getDeviceId(page);
    await expect
      .poll(async () => (await getAgentBrowserViaApi(page, opened.id))?.controller)
      .toBe("human");
    expect(
      (await getAgentBrowserViaApi(page, opened.id))?.controller_device_id,
    ).toBe(deviceId);

    // Click into the input at its mapped position and type.
    const input = await viewportToClient(page, opened.id, 250, 315);
    await page.mouse.click(input.x, input.y);
    await page.keyboard.type("bob");
    await expect
      .poll(() => agentBrowserSnapshotViaApi(page, opened.id))
      .toContain("typed:bob");

    // Click the button at its mapped position.
    const button = await viewportToClient(page, opened.id, 160, 220);
    await page.mouse.click(button.x, button.y);
    await expect
      .poll(() => agentBrowserSnapshotViaApi(page, opened.id))
      .toContain("clicked");
    await page.screenshot({ path: "e2e/artifacts/agent-browser-control.png" });

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
  });

  test("a handoff shows a banner and a tab indicator until a person has helped", async ({
    page,
  }) => {
    const opened = await openAgentBrowserViaApi(page, { url: formPage() });
    const pane = page.getByTestId(`agent-browser-pane-${opened.id}`);
    await expect(pane).toBeVisible();
    await expect(pane.getByTestId("agent-browser-handoff")).toHaveCount(0);
    const attention = page.locator("[data-testid^='workspace-tab-attention-']");
    await expect(attention).toHaveCount(0);

    await requestAgentBrowserHandoffViaApi(page, opened.id, "Please log in");
    const banner = pane.getByTestId("agent-browser-handoff");
    await expect(banner).toContainText("The agent needs you: Please log in");
    await expect(attention).toHaveCount(1);
    await page.screenshot({ path: "e2e/artifacts/agent-browser-handoff.png" });

    // Taking over from the banner swaps its button; the tab no longer nags.
    await banner.getByTestId("agent-browser-handoff-take").click();
    await expect(banner.getByTestId("agent-browser-handoff-release")).toBeVisible();
    await expect(banner.getByTestId("agent-browser-handoff-take")).toHaveCount(0);
    await expect(attention).toHaveCount(0);

    await banner.getByTestId("agent-browser-handoff-release").click();
    await expect(banner).toHaveCount(0);
    const record = await getAgentBrowserViaApi(page, opened.id);
    expect(record?.controller).toBe("agent");
    expect(record?.handoff).toBeUndefined();
  });

  test("another device's control is shown and can be taken over", async ({
    page,
  }) => {
    const opened = await openAgentBrowserViaApi(page, { url: formPage() });
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
