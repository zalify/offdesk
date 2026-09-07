import { test, expect, devices } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  createWorkspaceGroupViaApi,
  createTerminalViaApi,
  expandTerminalById,
  getImmersiveTerminal,
  listTerminals,
  listWorkspaceGroupsViaApi,
  longPressTitleBar,
  mobileOpenHostSheet,
  mobileTakeControl,
  openApp,
  requestMachineControl,
  resetMachineState,
  swipeTitleBar,
} from "./helpers";

test.use({
  ...devices["iPhone 14"],
  browserName: "chromium",
});

test("mobile terminal flow works inside the responsive web shell", async ({ page }) => {
  await openApp(page);
  await resetMachineState(page);

  // The mobile shell is title bar (top) + terminal (middle) + key bar
  // (bottom). With no terminals it shows the bar and a centered
  // "Start terminal" empty state; the start button needs control.
  await expect(page.getByTestId("mobile-workbench")).toBeVisible();
  await expect(page.getByTestId("mobile-title-bar")).toBeVisible();
  await expect(page.getByTestId("mobile-title-bar-dot")).toBeVisible();
  await expect(page.getByTestId("mobile-bar-new-terminal")).toHaveCSS(
    "width",
    "34px",
  );
  await expect(page.getByTestId("mobile-bar-new-terminal")).toHaveCSS(
    "height",
    "34px",
  );
  await expect(page.getByText(/No terminals yet/)).toBeVisible();
  await expect(page.getByTestId("empty-new-terminal")).toHaveCount(0);

  // Take control from the host sheet through the switcher header.
  await mobileTakeControl(page);
  await expect(page.getByTestId("empty-new-terminal")).toBeVisible();

  // Create a terminal — the shell opens straight into it.
  await page.getByTestId("empty-new-terminal").click();
  await expect(getImmersiveTerminal(page)).toBeVisible();

  // The title bar now identifies the session; the key bar surfaces the
  // keyboard toggle while controlling.
  const [terminal] = await listTerminals(page);
  expect(terminal).toBeDefined();
  await expect(page.getByTestId("mobile-title-bar-label")).toContainText(
    "shell",
  );
  await expect(page.getByTitle("Show keyboard")).toBeVisible();

  // Engage view-only via the host sheet: this releases control, so the
  // keyboard toggle stays in place disabled, as does the create button.
  await mobileOpenHostSheet(page);
  await expect(page.getByTestId("mobile-control-toggle")).toHaveText(
    "View only",
  );
  await page.getByTestId("mobile-control-toggle").click();
  await expect(page.getByTitle("Show keyboard")).toBeDisabled();
  await expect(page.getByTestId("mobile-bar-new-terminal")).toBeDisabled();

  // Unlock without claiming; the existing Take control flow remains explicit.
  await mobileOpenHostSheet(page);
  await expect(page.getByTestId("mobile-control-toggle")).toHaveText(
    "Unlock view only",
  );
  await page.getByTestId("mobile-control-toggle").click();

  // Take control back.
  await mobileTakeControl(page);
  await expect(page.getByTestId("mobile-bar-new-terminal")).toBeEnabled();

  // Destroy via API → the shell returns to the empty state.
  const deviceId = await page.evaluate(() => sessionStorage.getItem("tc-device-id"));
  const token = await page.evaluate(() => localStorage.getItem("offdesk:token"));
  const resp = await page.request.delete(
    `/api/machines/${terminal.machine_id}/terminals/${terminal.id}?device_id=${encodeURIComponent(deviceId ?? "")}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  expect(resp.ok()).toBeTruthy();
  await expect(page.getByText(/No terminals yet/)).toBeVisible();
  await expect(page.getByTestId("mobile-title-bar-label")).toContainText(
    "No terminal",
  );
});

test("mobile new terminal starts fitted without an immediate resize", async ({ page }) => {
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
  await mobileTakeControl(page);

  await page.getByTestId("empty-new-terminal").click();
  await expect(getImmersiveTerminal(page)).toBeVisible();

  await page.waitForTimeout(1_200);
  const resizeFrames = terminalFramesSent.filter((payload) =>
    payload.includes('"type":"resize"'),
  );
  // Mobile auto-fits on entry now. The server creates the terminal at our
  // estimated mobile dims; the live fit may agree (no resize) or produce
  // slightly different dims (one resize). Either is fine — what matters is
  // that the terminal isn't stuck at the desktop default 80 cols and
  // there's no resize storm.
  expect(resizeFrames.length).toBeLessThanOrEqual(1);

  const [terminal] = await listTerminals(page);
  expect(terminal.cols).toBeLessThan(80);
});

test("mobile controller refits the terminal when the visual viewport height changes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page);
  await resetMachineState(page);
  await requestMachineControl(page);
  const terminalId = await createTerminalViaApi(page);

  await expect(getImmersiveTerminal(page)).toBeVisible();
  await expect.poll(() => hasXtermInstance(page, terminalId)).toBe(true);
  const initial = await getXtermViewportState(page, terminalId);
  expect(initial.rows).toBeGreaterThan(0);

  await page.setViewportSize({ width: 390, height: 500 });
  await expect
    .poll(async () => (await getXtermViewportState(page, terminalId)).rows)
    .toBeLessThan(initial.rows);
  await expect
    .poll(async () => (await getXtermViewportState(page, terminalId)).cursorVisible)
    .toBe(true);

  const compactRows = (await getXtermViewportState(page, terminalId)).rows;
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(async () => (await getXtermViewportState(page, terminalId)).rows)
    .toBeGreaterThan(compactRows);
});

test("mobile terminal only focuses after an explicit input gesture", async ({
  page,
}) => {
  await openApp(page);
  await resetMachineState(page);
  await requestMachineControl(page);
  await createTerminalViaApi(page);

  // No card list anymore — the shell shows the terminal directly.
  await expect(getImmersiveTerminal(page)).toBeVisible();

  await expect
    .poll(() => terminalHasKeyboardFocus(page), { timeout: 20_000 })
    .toBe(false);

  await page.getByTitle("Show keyboard").click();
  await expect
    .poll(() => terminalHasKeyboardFocus(page), { timeout: 20_000 })
    .toBe(true);

  await page.getByTitle("Hide keyboard").click();
  await expect
    .poll(() => terminalHasKeyboardFocus(page), { timeout: 20_000 })
    .toBe(false);

  await getImmersiveTerminal(page).click({ position: { x: 40, y: 40 } });
  await expect
    .poll(() => terminalHasKeyboardFocus(page), { timeout: 20_000 })
    .toBe(true);
});

test("mobile terminal switch does not focus the new terminal automatically", async ({
  page,
}) => {
  await openApp(page);
  await resetMachineState(page);
  await requestMachineControl(page);
  const firstTerminalId = await createTerminalViaApi(page);
  const secondTerminalId = await createTerminalViaApi(page);
  await expect(page.getByTestId("mobile-title-bar")).toBeVisible();
  await expect(getImmersiveTerminal(page)).toBeVisible();

  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });
  await page.getByTestId("mobile-title-bar").click();
  await page.getByTestId(`mobile-session-row-${secondTerminalId}`).click();
  await expect(
    page.getByTestId(`workspace-pane-${secondTerminalId}`),
  ).toBeVisible();

  await expect
    .poll(() => terminalHasKeyboardFocus(page), { timeout: 20_000 })
    .toBe(false);
});

test("mobile touch drag sends terminal scroll input", async ({ page }) => {
  const inputFrames: string[] = [];
  page.on("websocket", (socket) => {
    if (!socket.url().includes("/ws/terminal/")) return;
    socket.on("framesent", (frame) => {
      if (typeof frame.payload !== "string") return;
      const payload = JSON.parse(frame.payload) as
        | { type: "input"; data: string }
        | { type: string };
      if (payload.type === "input") {
        inputFrames.push(payload.data);
      }
    });
  });

  await openApp(page);
  await resetMachineState(page);
  await requestMachineControl(page);
  const terminalId = await createTerminalViaApi(page, {
    cwd: "/root",
    startupCommand: "sleep 600",
  });

  await expect(getImmersiveTerminal(page)).toBeVisible();
  await expect.poll(() => hasXtermInstance(page, terminalId)).toBe(true);
  // The drag below only emits a wheel report once its pixel travel crosses a
  // line boundary, and it reports at whichever touchmove crossed first. On a
  // fitted terminal the first move (0.65h -> 0.5h) clears a line easily and
  // reports from the middle, which is what this test asserts. Before the fit
  // lands, .xterm-screen is a few pixels tall, the first move produces
  // nothing, and the report comes from the second move at 0.35h instead —
  // roughly a sixth of the screen off, so the assertion misses by more than
  // its tolerance. hasXtermInstance is true well before the fit, so wait for
  // a real height rather than assuming.
  await expect.poll(() => terminalScreenHeight(page)).toBeGreaterThan(200);

  const terminalSize = await waitForStableXtermSize(page, terminalId);
  inputFrames.length = 0;
  await dispatchTerminalTouchDrag(page);
  const expectedCol = Math.round(terminalSize.cols / 2);
  const expectedRow = Math.round(terminalSize.rows / 2);

  await expect
    .poll(() => {
      const frame = inputFrames.map(parseWheelMouseFrame).find(Boolean);
      if (!frame) return false;
      return (
        Math.abs(frame.col - expectedCol) <= 2 &&
        Math.abs(frame.row - expectedRow) <= 2
      );
    })
    .toBe(true);
});

test("mobile title bar swipes between sessions and long-presses the current session", async ({
  page,
}) => {
  await openApp(page);
  await resetMachineState(page);
  await requestMachineControl(page);

  const firstGroup = await createWorkspaceGroupViaApi(
    page,
    `Mobile Alpha ${Date.now()}`,
  );
  const secondGroup = await createWorkspaceGroupViaApi(
    page,
    `Mobile Beta ${Date.now()}`,
  );
  const firstTerminalId = await createTerminalViaApi(page, {
    cwd: "/root",
    workspaceGroupId: firstGroup.id,
  });
  const secondTerminalId = await createTerminalViaApi(page, {
    cwd: "/tmp",
    workspaceGroupId: secondGroup.id,
  });

  await page.getByTestId("mobile-title-bar").click();
  await page.getByTestId(`mobile-session-row-${firstTerminalId}`).click();
  await expect(
    page.getByTestId(`workspace-pane-${firstTerminalId}`),
  ).toBeVisible();
  await expect(page.getByTestId("mobile-title-bar-badge")).toHaveText("1/2");

  await swipeTitleBar(page, "left");
  await expect(
    page.getByTestId(`workspace-pane-${secondTerminalId}`),
  ).toBeVisible();
  await expect(page.getByTestId("mobile-title-bar-badge")).toHaveText("2/2");

  // Long-press the bar → sheet → Close terminal (no foreground process, so
  // no confirm dialog). The shell falls back to the remaining terminal.
  await longPressTitleBar(page);
  await page.getByTestId("mobile-chip-close-terminal").click();
  await expect.poll(async () => (await listTerminals(page)).length).toBe(1);
  await expect(page.getByTestId("mobile-title-bar-badge")).toHaveText("1/1");
  await expect(
    page.getByTestId(`workspace-pane-${firstTerminalId}`),
  ).toBeVisible();
});

test("session switcher opens with the active terminal row scrolled into view", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page);
  await resetMachineState(page);
  await requestMachineControl(page);

  // Enough rows that the last one starts beyond the sheet's scroll fold.
  const suffix = Date.now();
  let lastTerminalId = "";
  for (let index = 0; index < 3; index++) {
    const group = await createWorkspaceGroupViaApi(
      page,
      `Scroll ${suffix} ${index}`,
    );
    for (let pane = 0; pane < 4; pane++) {
      lastTerminalId = await createTerminalViaApi(page, {
        cwd: "/root",
        workspaceGroupId: group.id,
      });
    }
  }

  await expandTerminalById(page, lastTerminalId);
  await page.getByTestId("mobile-title-bar").click();
  await expect(page.getByTestId("mobile-session-switcher")).toBeVisible();
  const activeRow = page.getByTestId(`mobile-session-row-${lastTerminalId}`);
  await expect(activeRow).toHaveAttribute("aria-current", "true");
  await expect(activeRow).toBeInViewport();
});

test("session switcher row closes its terminal", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page);
  await resetMachineState(page);
  await requestMachineControl(page);

  const suffix = Date.now();
  const group = await createWorkspaceGroupViaApi(page, `Close ${suffix}`);
  const keptTerminalId = await createTerminalViaApi(page, {
    cwd: "/root",
    workspaceGroupId: group.id,
  });
  const closedTerminalId = await createTerminalViaApi(page, {
    cwd: "/tmp",
    workspaceGroupId: group.id,
  });

  await expandTerminalById(page, keptTerminalId);
  await page.getByTestId("mobile-title-bar").click();
  await expect(page.getByTestId("mobile-session-switcher")).toBeVisible();

  // The ✕ on a non-active row closes that session without leaving the sheet.
  await page.getByTestId(`mobile-session-close-${closedTerminalId}`).click();
  await expect(
    page.getByTestId(`mobile-session-row-${closedTerminalId}`),
  ).toHaveCount(0);
  await expect.poll(async () => (await listTerminals(page)).length).toBe(1);
  await expect(
    page.getByTestId(`mobile-session-row-${keptTerminalId}`),
  ).toBeVisible();
});

test("mobile title bar and grouped switcher expose titles, host stats, and create-current-group", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page);
  await resetMachineState(page);
  await requestMachineControl(page);

  const suffix = Date.now();
  const firstGroup = await createWorkspaceGroupViaApi(
    page,
    `Switcher Alpha ${suffix}`,
  );
  const secondGroup = await createWorkspaceGroupViaApi(
    page,
    `Switcher Beta ${suffix}`,
  );
  const firstTerminalId = await createTerminalViaApi(page, {
    cwd: "/root",
    workspaceGroupId: firstGroup.id,
  });
  const secondTerminalId = await createTerminalViaApi(page, {
    cwd: "/tmp",
    workspaceGroupId: secondGroup.id,
  });

  await page.getByTestId("mobile-title-bar").click();
  const sheet = page.getByTestId("mobile-session-switcher");
  await expect(sheet).toBeVisible();
  await page.getByTestId(`mobile-session-row-${firstTerminalId}`).click();
  await expect(page.getByTestId("mobile-title-bar-label")).toContainText(
    firstGroup.name,
  );
  await expect(page.getByTestId("mobile-title-bar-label")).toContainText(
    "shell",
  );
  await expect(page.getByTestId("mobile-title-bar-badge")).toHaveText("1/2");

  await page.getByTestId("mobile-title-bar").click();
  await expect(sheet).toBeVisible();
  await expect(
    page.getByTestId(`mobile-session-group-${firstGroup.id}`),
  ).toContainText(`${firstGroup.name} · 1 pane`);
  await expect(
    page.getByTestId(`mobile-session-group-${secondGroup.id}`),
  ).toContainText(`${secondGroup.name} · 1 pane`);
  await expect(
    page.getByTestId("mobile-session-switcher-new-terminal"),
  ).toBeVisible();
  await expect(
    page.getByTestId(`mobile-session-row-${firstTerminalId}`),
  ).toHaveAttribute("aria-current", "true");
  const header = page.getByTestId("mobile-session-header");
  await expect(header).toBeVisible();
  await expect(page.getByTestId("mobile-session-header-dot")).toBeVisible();
  await expect(page.getByTestId("mobile-host-button")).toContainText("e2e-machine");
  await expect(page.getByTestId("mobile-session-header-rtt")).toHaveText(
    /^(—|\d+ms)$/,
  );
  await expect(page.getByTestId("mobile-session-header-cpu")).toHaveText(
    /^cpu (—|\d+%)$/,
  );
  await expect(page.getByTestId("mobile-session-header-mem")).toHaveText(
    /^mem (—|\d+%)$/,
  );
  await expect(page.getByTestId("mobile-session-header-disk")).toHaveText(
    /^disk (—|\d+%)$/,
  );

  for (const terminalId of [firstTerminalId, secondTerminalId]) {
    const row = page.getByTestId(`mobile-session-row-${terminalId}`);
    await expect(row).toContainText("shell");
  }

  await page.getByTestId(`mobile-session-row-${firstTerminalId}`).click();
  const beforeIds = (await listTerminals(page)).map((terminal) => terminal.id);
  await page.getByTestId("mobile-bar-new-terminal").click();
  await expect.poll(async () => (await listTerminals(page)).length).toBe(3);
  const created = (await listTerminals(page)).find(
    (terminal) => !beforeIds.includes(terminal.id),
  );
  expect(created).toBeDefined();
  expect(created?.cwd).toBe("/root");
  expect(created?.workspace_group_id).toBe(firstGroup.id);
  await expect(page.getByTestId(`workspace-pane-${created!.id}`)).toBeVisible();
  await expect
    .poll(() => getMountedXtermIds(page))
    .toEqual([created!.id]);
});

test("mobile workspace manager provides full workspace controls", async ({ page }) => {
  await openApp(page);
  await resetMachineState(page);
  await mobileTakeControl(page);

  const first = await createWorkspaceGroupViaApi(
    page,
    `Mobile manager A ${Date.now()}`,
  );
  const second = await createWorkspaceGroupViaApi(
    page,
    `Mobile manager B ${Date.now()}`,
  );
  const terminalId = await createTerminalViaApi(page, {
    cwd: "/root",
    workspaceGroupId: first.id,
  });
  await expandTerminalById(page, terminalId);

  await page.getByTestId("mobile-title-bar").click();
  await page.getByTestId("mobile-workspace-manager-button").click();
  const manager = page.getByTestId("workspace-manager");
  await expect(manager).toBeVisible();
  await expect(manager).toHaveAttribute("data-placement", "sheet");
  await expect(
    manager.getByTestId(`workspace-manager-group-${first.id}`),
  ).toBeVisible();
  await expect(
    manager.getByTestId(`workspace-manager-group-${second.id}`),
  ).toBeVisible();

  await manager.getByTestId(`workspace-manager-rename-${second.id}`).click();
  const renamed = `Mobile renamed ${Date.now()}`;
  const renameDialog = page.getByRole("dialog", { name: "Rename tab" });
  await renameDialog
    .getByRole("textbox", { name: "Tab name" })
    .fill(renamed);
  await renameDialog.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(
    manager.getByTestId(`workspace-manager-group-${second.id}`),
  ).toContainText(renamed);

  await manager.getByTestId(`workspace-manager-move-${terminalId}`).click();
  await page.getByRole("menuitem", { name: renamed }).click();
  await expect
    .poll(async () =>
      (await listTerminals(page)).find((terminal) => terminal.id === terminalId)
        ?.workspace_group_id,
    )
    .toBe(second.id);

  await manager.getByTestId(`workspace-manager-up-${second.id}`).click();
  await expect
    .poll(async () => (await listWorkspaceGroupsViaApi(page))[0]?.id)
    .toBe(second.id);

  await manager.getByTestId(`workspace-manager-delete-${first.id}`).click();
  await expect
    .poll(async () =>
      (await listWorkspaceGroupsViaApi(page)).some(
        (group) => group.id === first.id,
      ),
    )
    .toBe(false);

  await manager.getByTestId("workspace-manager-new").click();
  await expect
    .poll(async () => (await listWorkspaceGroupsViaApi(page)).length)
    .toBe(2);
});

test("mobile + overflows a full tab into a new tab instead of a fifth pane", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page);
  await resetMachineState(page);
  await requestMachineControl(page);

  // Mobile shows one terminal at a time, but the same tab is a four-pane
  // split grid on desktop — so a full tab must not take a fifth terminal.
  const group = await createWorkspaceGroupViaApi(page, `Cap ${Date.now()}`);
  const seeded: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    seeded.push(
      await createTerminalViaApi(page, {
        cwd: "/root",
        workspaceGroupId: group.id,
      }),
    );
  }
  await expect.poll(async () => (await listTerminals(page)).length).toBe(4);

  // Make the full tab the active session, so "＋" aims at it.
  await page.getByTestId("mobile-title-bar").click();
  await expect(page.getByTestId("mobile-session-switcher")).toBeVisible();
  await page.getByTestId(`mobile-session-row-${seeded[0]}`).click();
  await expect(page.getByTestId("mobile-title-bar-label")).toContainText(
    group.name,
  );

  const beforeIds = (await listTerminals(page)).map((terminal) => terminal.id);
  await page.getByTestId("mobile-bar-new-terminal").click();

  // Creating still succeeds — the terminal just lands in a fresh tab.
  await expect.poll(async () => (await listTerminals(page)).length).toBe(5);
  const terminals = await listTerminals(page);
  const created = terminals.find((terminal) => !beforeIds.includes(terminal.id));
  expect(created).toBeDefined();
  expect(created?.workspace_group_id).not.toBe(group.id);
  expect(
    terminals.filter(
      (terminal) => terminal.workspace_group_id === group.id,
    ),
  ).toHaveLength(4);
  const groups = await listWorkspaceGroupsViaApi(page);
  expect(groups).toHaveLength(2);
});

test("mobile title bar receives a real OSC title through the terminal pipeline", async ({
  page,
}) => {
  await openApp(page);
  await resetMachineState(page);
  await requestMachineControl(page);
  const terminalId = await createTerminalViaApi(page);
  await expandTerminalById(page, terminalId);
  await expect(getImmersiveTerminal(page)).toBeVisible();

  await page.getByTitle("Show keyboard").click();
  await page.keyboard.type("printf '\\033]2;my-task\\007'");
  await page.keyboard.press("Enter");

  await expect
    .poll(
      async () => page.getByTestId("mobile-title-bar-label").textContent(),
      { timeout: 20_000 },
    )
    .toContain("my-task");
});

test("mobile Ctrl latch and pinned key-bar keys send bytes directly", async ({
  page,
}) => {
  const inputFrames: string[] = [];
  const commandFrames: string[] = [];
  page.on("websocket", (socket) => {
    if (!socket.url().includes("/ws/terminal/")) return;
    socket.on("framesent", (frame) => {
      if (typeof frame.payload !== "string") return;
      const payload = JSON.parse(frame.payload) as {
        type: string;
        data?: string;
      };
      if (payload.type === "input" && payload.data) {
        inputFrames.push(payload.data);
      }
      if (payload.type === "command_input" && payload.data) {
        commandFrames.push(payload.data);
      }
    });
  });

  await openApp(page);
  await resetMachineState(page);
  await requestMachineControl(page);
  await createTerminalViaApi(page, { startupCommand: "sleep 600" });
  await expect(getImmersiveTerminal(page)).toBeVisible();

  // Pinned Tab / Ctrl+C send their bytes immediately, unbuffered.
  await page.getByTestId("extended-keybar-tab").click();
  await page.getByTestId("extended-keybar-ctrl-c").click();
  await expect.poll(() => commandFrames).toContain("\t");
  await expect.poll(() => commandFrames).toContain("\x03");

  // Latch Ctrl: the next soft-keyboard letter goes out as its control byte,
  // then the latch disarms and the following letter sends as-is.
  await page.getByTitle("Show keyboard").click();
  await expect
    .poll(() => terminalHasKeyboardFocus(page), { timeout: 20_000 })
    .toBe(true);
  await page.getByTestId("extended-keybar-ctrl-latch").click();
  await page.keyboard.press("c");
  await expect.poll(() => inputFrames.includes("\x03")).toBe(true);
  await page.keyboard.press("c");
  await expect.poll(() => inputFrames.includes("c")).toBe(true);
});

test("mobile live streams reconnect after returning from background", async ({
  page,
}) => {
  const webSocketUrls: string[] = [];
  page.on("websocket", (socket) => {
    webSocketUrls.push(socket.url());
  });

  await openApp(page);
  await resetMachineState(page);
  await requestMachineControl(page);
  await createTerminalViaApi(page);
  await expect(getImmersiveTerminal(page)).toBeVisible();

  await expect
    .poll(
      () => webSocketUrls.filter((url) => url.includes("/ws/events")).length,
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);
  await expect
    .poll(
      () =>
        webSocketUrls.filter((url) =>
          url.includes("/ws/terminal/e2e-node/"),
        ).length,
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);

  const eventsBefore = webSocketUrls.filter((url) =>
    url.includes("/ws/events"),
  ).length;
  const terminalsBefore = webSocketUrls.filter((url) =>
    url.includes("/ws/terminal/e2e-node/"),
  ).length;

  await setPageVisibility(page, "hidden");
  await setPageVisibility(page, "visible");

  await expect
    .poll(
      () => webSocketUrls.filter((url) => url.includes("/ws/events")).length,
      { timeout: 20_000 },
    )
    .toBeGreaterThan(eventsBefore);
  await expect
    .poll(
      () =>
        webSocketUrls.filter((url) =>
          url.includes("/ws/terminal/e2e-node/"),
        ).length,
      { timeout: 20_000 },
    )
    .toBeGreaterThan(terminalsBefore);
});

async function setPageVisibility(
  page: Parameters<typeof openApp>[0],
  visibilityState: "hidden" | "visible",
): Promise<void> {
  await page.evaluate((nextVisibilityState) => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => nextVisibilityState,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }, visibilityState);
}

async function hasXtermInstance(
  page: Page,
  terminalId: string,
): Promise<boolean> {
  return page.evaluate((tid) => {
    const map = (
      window as unknown as {
        __offdeskTerminals?: Map<string, unknown>;
      }
    ).__offdeskTerminals;
    return map?.has(tid) ?? false;
  }, terminalId);
}

async function getMountedXtermIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const map = (
      window as unknown as {
        __offdeskTerminals?: Map<string, unknown>;
      }
    ).__offdeskTerminals;
    return [...(map?.keys() ?? [])];
  });
}

async function getXtermSize(
  page: Page,
  terminalId: string,
): Promise<{ cols: number; rows: number }> {
  return page.evaluate((tid) => {
    const map = (
      window as unknown as {
        __offdeskTerminals?: Map<string, { cols: number; rows: number }>;
      }
    ).__offdeskTerminals;
    const term = map?.get(tid);
    return { cols: term?.cols ?? 0, rows: term?.rows ?? 0 };
  }, terminalId);
}

async function waitForStableXtermSize(
  page: Page,
  terminalId: string,
): Promise<{ cols: number; rows: number }> {
  let previous = "";
  let repeated = 0;
  await expect
    .poll(
      async () => {
        const size = await getXtermSize(page, terminalId);
        const current = `${size.cols}x${size.rows}`;
        repeated = current === previous && size.cols > 0 && size.rows > 0
          ? repeated + 1
          : 0;
        previous = current;
        return repeated >= 2;
      },
      { timeout: 10_000, intervals: [100, 100, 200, 300] },
    )
    .toBe(true);
  return getXtermSize(page, terminalId);
}

async function getXtermViewportState(
  page: Page,
  terminalId: string,
): Promise<{ rows: number; cursorVisible: boolean }> {
  return page.evaluate((tid) => {
    const map = (
      window as unknown as {
        __offdeskTerminals?: Map<
          string,
          {
            rows: number;
            buffer: {
              active: {
                baseY: number;
                cursorY: number;
                viewportY: number;
              };
            };
          }
        >;
      }
    ).__offdeskTerminals;
    const term = map?.get(tid);
    if (!term) return { rows: 0, cursorVisible: false };
    const buffer = term.buffer.active;
    const cursorRow = buffer.baseY + buffer.cursorY;
    return {
      rows: term.rows,
      cursorVisible:
        cursorRow >= buffer.viewportY &&
        cursorRow < buffer.viewportY + term.rows,
    };
  }, terminalId);
}

async function dispatchTerminalTouchDrag(page: Page): Promise<void> {
  await getImmersiveTerminal(page)
    .locator(".xterm-screen")
    .evaluate((screen) => {
      const rect = screen.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const startY = rect.top + rect.height * 0.65;
      const endY = rect.top + rect.height * 0.35;

      function dispatch(
        type: "touchstart" | "touchmove" | "touchend",
        y: number,
      ) {
        const touch = new Touch({
          identifier: 1,
          target: screen,
          clientX: x,
          clientY: y,
          pageX: x,
          pageY: y,
          screenX: x,
          screenY: y,
        });
        screen.dispatchEvent(
          new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            touches: type === "touchend" ? [] : [touch],
            targetTouches: type === "touchend" ? [] : [touch],
            changedTouches: [touch],
          }),
        );
      }

      dispatch("touchstart", startY);
      dispatch("touchmove", (startY + endY) / 2);
      dispatch("touchmove", endY);
      dispatch("touchend", endY);
    });
}

/** Rendered height of the terminal screen, in CSS pixels. */
async function terminalScreenHeight(page: Page): Promise<number> {
  return getImmersiveTerminal(page)
    .locator(".xterm-screen")
    .evaluate((screen) => screen.getBoundingClientRect().height);
}

function parseWheelMouseFrame(
  data: string,
): { col: number; row: number } | null {
  const match = /\x1b\[<(?:64|65);(\d+);(\d+)M/.exec(data);
  if (!match) return null;
  return {
    col: Number(match[1]),
    row: Number(match[2]),
  };
}

async function terminalHasKeyboardFocus(
  page: Parameters<typeof openApp>[0],
): Promise<boolean> {
  return page.evaluate(() => {
    const active = document.activeElement;
    return active instanceof HTMLElement && active.closest(".xterm") !== null;
  });
}
