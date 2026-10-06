import { expect, test, type Page } from "@playwright/test";

import {
  closeAgentBrowserViaApi,
  createTerminalViaApi,
  gotoAgentBrowserViaApi,
  openAgentBrowserViaApi,
  openApp,
  resetMachineState,
  takeControlFromHeader,
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
    await expect(pane.getByText("View only")).toBeVisible();
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
});
