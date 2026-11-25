import { expect, test, devices } from "@playwright/test";

import {
  createTerminalViaApi,
  expandOnlyTerminal,
  expandTerminalById,
  expectControlState,
  expectTerminalCount,
  fitPaneViaContextMenu,
  getAuthHeaders,
  getDeviceId,
  getImmersiveTerminal,
  getTerminalViewJustify,
  getTerminalViewScale,
  listTerminals,
  mobileOpenHostSheet,
  mobileTakeControl,
  openApp,
  resetMachineState,
  selectHomeWorkpath,
  stableTerminalFields,
  takeControlFromHeader,
} from "./helpers";

test("mobile viewing stays readable when desktop explicitly sizes the shared terminal", async ({
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
  const tid = await createTerminalViaApi(desktopPage, { cwd: "/root" });
  await expandTerminalById(desktopPage, tid);
  await expect(getImmersiveTerminal(desktopPage)).toBeVisible();

  await fitPaneViaContextMenu(desktopPage, tid);

  // Explicit desktop fit pushes the terminal past the 80x24 defaults.
  await expect
    .poll(async () => {
      const [terminal] = await listTerminals(desktopPage);
      return terminal?.cols ?? 0;
    })
    .toBeGreaterThan(80);

  const [desktopSizedTerminal] = await listTerminals(desktopPage);
  expect(desktopSizedTerminal).toBeDefined();

  await openApp(mobilePage);
  await expect.poll(async () => (await listTerminals(mobilePage)).length).toBe(1);

  // Mobile is in view-only mode — the shell opens straight into the shared
  // terminal (there is no card list anymore).
  await expect(getImmersiveTerminal(mobilePage)).toBeVisible();

  // An unlocked viewer can open the keyboard and implicitly claim by typing;
  // the host sheet keeps the explicit "Take control" path as well.
  await expect(mobilePage.getByTitle("Show keyboard")).toBeVisible();
  await mobileOpenHostSheet(mobilePage);
  await expect(mobilePage.getByTestId("mobile-control-toggle")).toHaveText(
    "Take control",
  );
  await mobilePage.keyboard.press("Escape");

  await expect
    .poll(async () => getTerminalViewScale(mobilePage))
    .toBe(1);
  // Compare stable fields only: title/title_source are live-reported and may
  // legitimately change between the two listings.
  await expect
    .poll(async () => (await listTerminals(mobilePage)).map(stableTerminalFields))
    .toEqual([stableTerminalFields(desktopSizedTerminal!)]);

  await desktop.close();
  await mobile.close();
});

test("terminal can be manually fitted by whichever device currently holds control", async ({
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
  const tid = await createTerminalViaApi(desktopPage, { cwd: "/root" });
  await expandTerminalById(desktopPage, tid);

  // Desktop controller → terminal fits to desktop dims when requested.
  await fitPaneViaContextMenu(desktopPage, tid);
  await expect
    .poll(async () => {
      const [terminal] = await listTerminals(desktopPage);
      return terminal?.cols ?? 0;
    })
    .toBeGreaterThan(80);
  const [desktopSizedTerminal] = await listTerminals(desktopPage);
  expect(desktopSizedTerminal).toBeDefined();

  await openApp(mobilePage);
  // The shell opens straight into the shared terminal (no card list).
  await expect(getImmersiveTerminal(mobilePage)).toBeVisible();

  // Mobile takes control via the host sheet.
  await mobileTakeControl(mobilePage);
  // Desktop flips to view-only — the TabBar's viewing pill appears.
  await expectControlState(desktopPage, "viewing");

  // Becoming the controller auto-fits the terminal to the mobile dims (the
  // old manual Fit button is gone — activation fits now). Poll `cols` directly
  // so live metadata changes (title/last_activity_ms) cannot satisfy the poll
  // before the resize actually lands.
  let mobileSizedTerminal = desktopSizedTerminal;
  await expect
    .poll(async () => {
      const [terminal] = await listTerminals(mobilePage);
      mobileSizedTerminal = terminal;
      return terminal?.cols ?? Infinity;
    })
    .toBeLessThan(desktopSizedTerminal!.cols);

  // Desktop re-opens the overlay and sees the narrower terminal centred.
  await expandOnlyTerminal(desktopPage);
  await expect
    .poll(async () => getTerminalViewJustify(desktopPage))
    .toBe("center");
  await expect
    .poll(async () => getTerminalViewScale(desktopPage))
    .toBe(1);

  // Hand control back to desktop via the TabBar's viewing pill.
  await desktopPage.getByTestId("workbench-request-control").click();
  await expect(desktopPage.getByTestId("workbench-request-control")).toHaveCount(0);
  await mobileOpenHostSheet(mobilePage);
  await expect(mobilePage.getByTestId("mobile-control-toggle")).toHaveText(
    "Take control",
  );
  await mobilePage.keyboard.press("Escape");
  await expandOnlyTerminal(desktopPage);
  await expect(getImmersiveTerminal(desktopPage)).toBeVisible();

  // Desktop is controller again → terminal fits back to desktop dims when requested.
  await fitPaneViaContextMenu(desktopPage, tid);
  await expect
    .poll(async () => {
      const [terminal] = await listTerminals(desktopPage);
      return terminal?.cols ?? 0;
    })
    .toBeGreaterThan(mobileSizedTerminal!.cols);
  await expect
    .poll(async () => getTerminalViewScale(mobilePage))
    .toBe(1);

  await desktop.close();
  await mobile.close();
});

test("multiple shared terminals stay in sync across mobile handoff and selective close", async ({
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

  await createTerminalViaApi(desktopPage, { cwd: "/root" });
  await createTerminalViaApi(desktopPage, { cwd: "/root" });

  await expect
    .poll(async () => (await listTerminals(desktopPage)).length)
    .toBe(2);

  const initialTerminalIds = (await listTerminals(desktopPage))
    .map((terminal) => terminal.id)
    .sort();

  await expectTerminalCount(desktopPage, 2);
  await openApp(mobilePage);
  await expect.poll(async () => (await listTerminals(mobilePage)).length).toBe(2);

  // Mobile takes control via API (avoid UI overlap fights).
  const mobileHeaders = await getAuthHeaders(mobilePage);
  const mobileDeviceId = await getDeviceId(mobilePage);
  await mobilePage.request.post("/api/mode/control", {
    headers: mobileHeaders,
    data: { machine_id: "e2e-node", device_id: mobileDeviceId },
  });
  await expectControlState(desktopPage, "viewing");

  // Mobile closes one terminal via API.
  const mobileTerminals = await listTerminals(mobilePage);
  await mobilePage.request.delete(
    `/api/machines/${mobileTerminals[0].machine_id}/terminals/${mobileTerminals[0].id}?device_id=${encodeURIComponent(mobileDeviceId)}`,
    { headers: mobileHeaders },
  );
  await expect.poll(async () => (await listTerminals(mobilePage)).length).toBe(1);
  await expect.poll(async () => (await listTerminals(desktopPage)).length).toBe(1);

  const remainingDesktopTerminals = await listTerminals(desktopPage);
  const remainingMobileTerminals = await listTerminals(mobilePage);
  expect(remainingDesktopTerminals).toEqual(remainingMobileTerminals);
  expect(remainingDesktopTerminals).toHaveLength(1);
  expect(initialTerminalIds).toContain(remainingDesktopTerminals[0]?.id);

  await desktop.close();
  await mobile.close();
});
