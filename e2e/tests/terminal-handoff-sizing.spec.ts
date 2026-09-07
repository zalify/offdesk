import { expect, test, devices, type Page } from "@playwright/test";

import {
  createTerminalViaApi,
  expandOnlyTerminal,
  expandTerminalById,
  fitPaneViaContextMenu,
  getAuthHeaders,
  getDeviceId,
  getImmersiveTerminal,
  listTerminals,
  mobileTakeControl,
  openApp,
  releaseMachineControl,
  resetMachineState,
  selectHomeWorkpath,
  stableTerminalFields,
  takeControlFromHeader,
} from "./helpers";

test("opening an existing terminal keeps its pty size until Fit is requested", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
  });
  const page = await context.newPage();
  const terminalFramesSent: string[] = [];

  page.on("websocket", (socket) => {
    if (!socket.url().includes("/ws/terminal/")) return;
    socket.on("framesent", (frame) => {
      if (typeof frame.payload === "string") {
        terminalFramesSent.push(frame.payload);
      }
    });
  });

  await openApp(page);
  await resetMachineState(page);
  await takeControlFromHeader(page);
  await selectHomeWorkpath(page);
  const tid = await createTerminalViaApi(page, { cwd: "/tmp" });

  await expandTerminalById(page, tid);
  await expect(getImmersiveTerminal(page)).toBeVisible();

  await page.waitForTimeout(1_200);

  const resizeFrames = terminalFramesSent.filter((payload) =>
    payload.includes('"type":"resize"'),
  );
  expect(resizeFrames).toEqual([]);

  const [terminal] = await listTerminals(page);
  expect(terminal?.cols).toBe(80);
  expect(terminal?.rows).toBe(24);

  await fitPaneViaContextMenu(page, tid);
  await expect
    .poll(async () => {
      const [current] = await listTerminals(page);
      return current?.cols ?? 0;
    })
    .toBeGreaterThan(80);

  await context.close();
});

test("terminal size stays stable across overlay and cross-device handoff until fit is requested", async ({
  browser,
}) => {
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const mobile = await browser.newContext({
    ...devices["iPhone 14"],
    browserName: "chromium",
  });
  const desktopPage = await desktop.newPage();
  const mobilePage = await mobile.newPage();

  await openApp(desktopPage);
  await resetMachineState(desktopPage);
  await takeControlFromHeader(desktopPage);
  await selectHomeWorkpath(desktopPage);
  const tid = await createTerminalViaApi(desktopPage, { cwd: "/tmp" });

  // Open the terminal in the ExpandedTerminal overlay.
  await expandTerminalById(desktopPage, tid);
  await expect(getImmersiveTerminal(desktopPage)).toBeVisible();

  const [initialTerminal] = await listTerminals(desktopPage);
  expect(initialTerminal).toBeDefined();
  expect(initialTerminal?.cols).toBe(80);
  expect(initialTerminal?.rows).toBe(24);

  // Compare stable fields only: title/title_source are live-reported and may
  // legitimately change between listings; size fidelity is what matters here.
  await expect
    .poll(async () => (await listTerminals(desktopPage)).map(stableTerminalFields))
    .toEqual([stableTerminalFields(initialTerminal!)]);

  // Mobile viewer: the shell opens straight into the shared terminal (there
  // is no card list anymore) — watching needs no control. The mobile
  // session still sees the same authoritative cols/rows and renders at
  // scale 1.
  await openApp(mobilePage);
  await expect(getImmersiveTerminal(mobilePage)).toBeVisible();

  // Server pty size is unchanged because opening a view never resizes it.
  await expect
    .poll(async () => (await listTerminals(mobilePage)).map(stableTerminalFields))
    .toEqual([stableTerminalFields(initialTerminal!)]);
  await expect
    .poll(async () =>
      Number(
        await getImmersiveTerminal(mobilePage).getAttribute("data-terminal-view-scale"),
      ),
    )
    .toBe(1);

  await mobile.close();
  await desktop.close();
});

test("mobile controller resizes the shared pty on activation (auto-fit)", async ({
  browser,
}) => {
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const mobile = await browser.newContext({
    ...devices["iPhone 14"],
    browserName: "chromium",
  });
  const desktopPage = await desktop.newPage();
  const mobilePage = await mobile.newPage();

  await openApp(desktopPage);
  await resetMachineState(desktopPage);
  await takeControlFromHeader(desktopPage);
  await selectHomeWorkpath(desktopPage);
  const tid = await createTerminalViaApi(desktopPage, { cwd: "/tmp" });
  await expandTerminalById(desktopPage, tid);

  await fitPaneViaContextMenu(desktopPage, tid);

  let desktopInitial: Awaited<ReturnType<typeof listTerminals>>[number] | null = null;
  await expect.poll(async () => {
    const terminals = await listTerminals(desktopPage);
    if (terminals.length !== 1) return false;
    if (terminals[0].cols === 80 && terminals[0].rows === 24) return false;
    desktopInitial = terminals[0];
    return true;
  }).toBe(true);

  // Mobile opens the same terminal directly (no card list); desktop
  // releases control so mobile can take it.
  await openApp(mobilePage);
  await expect(getImmersiveTerminal(mobilePage)).toBeVisible();

  // Desktop releases via the API (the new chrome has no release button),
  // mobile takes control via the host sheet.
  await releaseMachineControl(desktopPage);
  await expect(desktopPage.getByTestId("workbench-request-control")).toBeVisible();

  await mobileTakeControl(mobilePage);

  // Becoming the controller auto-fits to the mobile viewport → server
  // cols/rows shrink (no manual Fit button anymore).
  await expect
    .poll(async () => {
      const [terminal] = await listTerminals(mobilePage);
      return terminal;
    })
    .not.toEqual(desktopInitial);

  // Desktop re-opens the overlay and sees the narrower terminal centred.
  await expandOnlyTerminal(desktopPage);
  await expect
    .poll(async () =>
      await getImmersiveTerminal(desktopPage).getAttribute("data-terminal-view-justify"),
    )
    .toBe("center");
  await expect
    .poll(async () =>
      Number(
        await getImmersiveTerminal(desktopPage).getAttribute("data-terminal-view-scale"),
      ),
    )
    .toBe(1);

  // Clean up via API — mobile holds control.
  const mobileHeaders = await getAuthHeaders(mobilePage);
  const mobileDeviceId = await getDeviceId(mobilePage);
  for (const t of await listTerminals(mobilePage)) {
    await mobilePage.request.delete(
      `/api/machines/${t.machine_id}/terminals/${t.id}?device_id=${encodeURIComponent(mobileDeviceId)}`,
      { headers: mobileHeaders },
    );
  }
  await expect.poll(async () => listTerminals(mobilePage)).toEqual([]);

  await desktop.close();
  await mobile.close();
});

test("Fit to Window updates the local terminal size before resize output can arrive", async ({
  browser,
}) => {
  const mobile = await browser.newContext({
    ...devices["iPhone 14"],
    browserName: "chromium",
  });
  const page = await mobile.newPage();
  let resizeFrame: { cols: number; rows: number } | null = null;
  let resolveResizeFrame: (() => void) | null = null;
  const resizeFrameSeen = new Promise<void>((resolve) => {
    resolveResizeFrame = resolve;
  });

  page.on("websocket", (socket) => {
    if (!socket.url().includes("/ws/terminal/")) return;
    socket.on("framesent", (frame) => {
      if (typeof frame.payload !== "string") return;
      const payload = JSON.parse(frame.payload) as
        | { type: "resize"; cols: number; rows: number }
        | { type: string };
      if (payload.type !== "resize") return;
      resizeFrame = payload;
      resolveResizeFrame?.();
    });
  });

  await openApp(page);
  await resetMachineState(page);
  await mobileTakeControl(page);
  const terminalId = await createTerminalViaApi(page, { cwd: "/tmp" });
  // The shell shows the terminal directly (no card list); as the controller,
  // activating the pane auto-fits it. The contract this test guards is that
  // the local terminal size moves in lockstep with the resize frame the
  // client sends, never lagging behind a server echo. (Used to be
  // triggered by a manual Fit click; mobile now does it automatically on
  // entry.)
  await expect(getImmersiveTerminal(page)).toBeVisible();
  await resizeFrameSeen;
  expect(resizeFrame).not.toBeNull();
  expect(await getLocalTerminalSize(page, terminalId)).toEqual({
    cols: resizeFrame!.cols,
    rows: resizeFrame!.rows,
  });

  await mobile.close();
});

async function getLocalTerminalSize(
  page: Page,
  terminalId: string,
): Promise<{ cols: number; rows: number } | null> {
  return page.evaluate((tid) => {
    const map = (
      window as unknown as {
        __offdeskTerminals?: Map<string, { cols: number; rows: number }>;
      }
    ).__offdeskTerminals;
    const terminal = map?.get(tid);
    if (!terminal) return null;
    return { cols: terminal.cols, rows: terminal.rows };
  }, terminalId);
}
