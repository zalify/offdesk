import { expect, test, type Page } from "@playwright/test";

import {
  createWorkspaceGroupViaApi,
  createTerminalViaApi,
  deleteWorkspaceGroupViaApi,
  expandTerminalById,
  fitPaneViaContextMenu,
  getAuthHeaders,
  getExpandedOverlay,
  listTerminals,
  listWorkspaceGroupsViaApi,
  openApp,
  openPaneContextMenu,
  pressPrefixKey,
  resetMachineState,
  selectHomeWorkpath,
  takeControlFromHeader,
} from "./helpers";

test("splitting a fallback terminal keeps both panes in one tab", async ({
  page,
}) => {
  await openApp(page);
  await resetMachineState(page);
  await takeControlFromHeader(page);

  const group = await createWorkspaceGroupViaApi(
    page,
    `Fallback split ${Date.now()}`,
  );
  const firstId = await createTerminalViaApi(page, {
    cwd: "/root",
    workspaceGroupId: group.id,
  });
  await expandTerminalById(page, firstId);

  // Ungrouping leaves the terminal in a derived cwd tab with no persisted
  // workspace-group id. Splitting that pane must still stay in this one tab.
  await deleteWorkspaceGroupViaApi(page, group.id);
  await expect
    .poll(async () =>
      (await listTerminals(page)).find((terminal) => terminal.id === firstId)
        ?.workspace_group_id,
    )
    .toBeNull();
  await expect(page.locator("[data-testid^='workspace-tab-']")).toHaveCount(1);

  await openPaneContextMenu(page, firstId);
  await page.getByRole("menuitem", { name: "Split right" }).click();

  await expect.poll(async () => (await listTerminals(page)).length).toBe(2);
  await expect(page.locator("[data-testid^='workspace-pane-']")).toHaveCount(2);
  await expect(page.locator("[data-testid^='workspace-tab-']")).toHaveCount(1);

  const terminals = await listTerminals(page);
  const workspaceGroupIds = new Set(
    terminals.map((terminal) => terminal.workspace_group_id),
  );
  expect(workspaceGroupIds.size).toBe(1);
  expect([...workspaceGroupIds][0]).toBeTruthy();
});

test("desktop workspace splits the active terminal into tiled panes", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
  });
  const page = await context.newPage();

  await openApp(page);
  await resetMachineState(page);
  await takeControlFromHeader(page);
  await selectHomeWorkpath(page);

  await page.getByTestId("empty-new-terminal").click();
  await expect(page.getByTestId("expanded-terminal")).toBeVisible();
  await expect.poll(async () => (await listTerminals(page)).length).toBe(1);
  const firstId = (await listTerminals(page))[0].id;

  // ⌃B %
  await pressPrefixKey(page, "Shift+Digit5");
  await expect.poll(async () => (await listTerminals(page)).length).toBe(2);
  const terminals = await listTerminals(page);
  await expect(page.locator("[data-testid^='workspace-pane-']")).toHaveCount(2);
  for (const terminal of terminals) {
    await expect(
      page.getByTestId(`workspace-pane-${terminal.id}`),
    ).toBeVisible();
  }

  const secondId = page.url().split("#/t/")[1];
  expect(secondId).toBeTruthy();
  expect(secondId).not.toBe(firstId);
  const firstBox = await paneBox(page, firstId);
  const secondBox = await paneBox(page, secondId);
  expect(secondBox.x).toBeGreaterThan(firstBox.x + firstBox.width * 0.5);
  expect(Math.abs(secondBox.y - firstBox.y)).toBeLessThan(8);
  await expect
    .poll(() => paneTerminalScale(page, secondId), { timeout: 5_000 })
    .toBeGreaterThan(0.95);
  await expect
    .poll(() => paneTerminalScale(page, firstId), { timeout: 5_000 })
    .toBeGreaterThan(0.95);
  await expect
    .poll(async () => {
      const splitTerminal = (await listTerminals(page)).find(
        (terminal) => terminal.id === secondId,
      );
      return splitTerminal?.cols ?? 999;
    }, { timeout: 5_000 })
    .toBeLessThan(140);
  await expect
    .poll(async () => {
      const originalTerminal = (await listTerminals(page)).find(
        (terminal) => terminal.id === firstId,
      );
      return originalTerminal?.cols ?? 999;
    }, { timeout: 5_000 })
    .toBeLessThan(140);
  await expect
    .poll(() => paneXtermScrollbarWidth(page, secondId), { timeout: 5_000 })
    .toBe("none");

  // ⌃B "
  await pressPrefixKey(page, "Shift+Quote");
  await expect.poll(async () => (await listTerminals(page)).length).toBe(3);
  const afterDown = await listTerminals(page);
  const thirdId = afterDown.find(
    (terminal) => !terminals.some((existing) => existing.id === terminal.id),
  )!.id;
  await expect(page.locator("[data-testid^='workspace-pane-']")).toHaveCount(3);
  const previousActiveBox = await paneBox(page, secondId);
  const thirdBox = await paneBox(page, thirdId);
  expect(Math.abs(thirdBox.x - previousActiveBox.x)).toBeLessThan(8);
  expect(thirdBox.y).toBeGreaterThan(
    previousActiveBox.y + previousActiveBox.height * 0.5,
  );

  await context.close();
});

test("a tab caps at four panes and new terminals overflow into a new tab", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
  });
  const page = await context.newPage();

  await openApp(page);
  await resetMachineState(page);
  await takeControlFromHeader(page);
  await selectHomeWorkpath(page);

  await page.getByTestId("empty-new-terminal").click();
  await expect(page.getByTestId("expanded-terminal")).toBeVisible();
  await expect.poll(async () => (await listTerminals(page)).length).toBe(1);

  // ⌃B % three times fills the tab to the cap.
  for (let i = 0; i < 3; i += 1) {
    await pressPrefixKey(page, "Shift+Digit5");
    await expect(page.locator("[data-testid^='workspace-pane-']")).toHaveCount(
      i + 2,
    );
  }

  // The fifth split is refused — and says so, since the shortcut gives no
  // other feedback.
  await pressPrefixKey(page, "Shift+Digit5");
  await expect(page.getByTestId("workspace-toast")).toBeVisible();
  await expect(page.locator("[data-testid^='workspace-pane-']")).toHaveCount(4);
  await expect.poll(async () => (await listTerminals(page)).length).toBe(4);

  // The context menu greys the split entries out on a full tab.
  const activeId = page.url().split("#/t/")[1];
  await openPaneContextMenu(page, activeId);
  await expect(page.getByRole("menuitem", { name: "Split right" })).toBeDisabled();
  await expect(page.getByRole("menuitem", { name: "Split down" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("context-menu")).toHaveCount(0);

  // ⌃B c still creates: the terminal lands in a fresh tab instead of becoming
  // a fifth pane in the full one.
  await pressPrefixKey(page, "c");
  await expect.poll(async () => (await listTerminals(page)).length).toBe(5);
  // Keep-alive: the full tab stays mounted but hidden, so only count the
  // visible panes of the fresh tab.
  await expect(
    page.locator("[data-testid^='workspace-pane-']:visible"),
  ).toHaveCount(1);
  const groups = await listWorkspaceGroupsViaApi(page);
  expect(groups).toHaveLength(2);
  // Four panes in the first tab, the fifth terminal alone in the second.
  const terminals = await listTerminals(page);
  expect(
    new Set(terminals.map((terminal) => terminal.workspace_group_id)).size,
  ).toBe(2);

  await context.close();
});

test("desktop workspace rotates a stacked pane layout via the palette", async ({
  page,
}) => {
  await openApp(page);
  await resetMachineState(page);
  await takeControlFromHeader(page);

  const firstId = await createTerminalViaApi(page, { cwd: "/root" });
  await expandTerminalById(page, firstId);

  // ⌃B " — two panes stacked top/bottom.
  await pressPrefixKey(page, "Shift+Quote");
  await expect.poll(async () => (await listTerminals(page)).length).toBe(2);
  const secondId = (await listTerminals(page)).find(
    (terminal) => terminal.id !== firstId,
  )!.id;
  await expect(page.locator("[data-testid^='workspace-pane-']")).toHaveCount(2);

  const stackedFirstBox = await paneBox(page, firstId);
  const stackedSecondBox = await paneBox(page, secondId);
  expect(Math.abs(stackedSecondBox.x - stackedFirstBox.x)).toBeLessThan(8);
  expect(stackedSecondBox.y).toBeGreaterThan(
    stackedFirstBox.y + stackedFirstBox.height * 0.5,
  );

  // Rotate via the command palette: stacked → side-by-side.
  await pressPrefixKey(page, "k");
  await expect(page.getByTestId("command-palette")).toBeVisible();
  await page.getByTestId("command-palette-row-rotate-layout").click();
  await expect(page.getByTestId("command-palette")).toHaveCount(0);

  await expect
    .poll(
      async () => {
        const firstBox = await paneBox(page, firstId);
        const secondBox = await paneBox(page, secondId);
        return (
          Math.abs(secondBox.y - firstBox.y) < 8 &&
          secondBox.x > firstBox.x + firstBox.width * 0.5
        );
      },
      { timeout: 5_000 },
    )
    .toBe(true);

  // ⌃B r — rotate back to stacked.
  await pressPrefixKey(page, "r");
  await expect
    .poll(
      async () => {
        const firstBox = await paneBox(page, firstId);
        const secondBox = await paneBox(page, secondId);
        return (
          Math.abs(secondBox.x - firstBox.x) < 8 &&
          secondBox.y > firstBox.y + firstBox.height * 0.5
        );
      },
      { timeout: 5_000 },
    )
    .toBe(true);
});

test("desktop workspace stays open when closing an inactive pane", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
  });
  const page = await context.newPage();

  await openApp(page);
  await resetMachineState(page);
  await takeControlFromHeader(page);
  await selectHomeWorkpath(page);

  const firstId = await createTerminalViaApi(page);
  await expandTerminalById(page, firstId);
  await expect(getExpandedOverlay(page)).toBeVisible();
  await pressPrefixKey(page, "Shift+Digit5");
  await expect.poll(async () => (await listTerminals(page)).length).toBe(2);

  // Close the (now inactive) first pane via its right-click context menu.
  await openPaneContextMenu(page, firstId);
  await page.getByRole("menuitem", { name: "Close pane" }).click();
  await expect(page.getByTestId("context-menu")).toHaveCount(0);

  await expect.poll(async () => (await listTerminals(page)).length).toBe(1);
  await expect(getExpandedOverlay(page)).toBeVisible();
  await expect(page.locator("[data-testid^='workspace-pane-']")).toHaveCount(1);
  await expect(page).not.toHaveURL(new RegExp(`#/t/${firstId}$`));

  await context.close();
});

// OFF-44: the pane left after a close grows into the freed rect without
// remounting, so it must refit (and resize its tmux session) like a split.
test("closing a pane refits the pane left to the freed width", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
  });
  const page = await context.newPage();

  await openApp(page);
  await resetMachineState(page);
  await takeControlFromHeader(page);
  await selectHomeWorkpath(page);

  const firstId = await createTerminalViaApi(page);
  await expandTerminalById(page, firstId);
  await expect(getExpandedOverlay(page)).toBeVisible();

  // ⌃B % — side by side. Fit the first pane explicitly so its half-width
  // size is settled on the machine before the close.
  await pressPrefixKey(page, "Shift+Digit5");
  await expect.poll(async () => (await listTerminals(page)).length).toBe(2);
  const secondId = (await listTerminals(page)).find(
    (terminal) => terminal.id !== firstId,
  )!.id;
  await fitPaneViaContextMenu(page, firstId);
  await expect
    .poll(() => serverCols(page, firstId), { timeout: 5_000 })
    .toBe(await localCols(page, firstId));
  const splitCols = await serverCols(page, firstId);

  await openPaneContextMenu(page, secondId);
  await page.getByRole("menuitem", { name: "Close pane" }).click();
  await expect.poll(async () => (await listTerminals(page)).length).toBe(1);
  await expect(page.locator("[data-testid^='workspace-pane-']")).toHaveCount(1);

  await expect
    .poll(() => serverCols(page, firstId), { timeout: 5_000 })
    .toBeGreaterThan(splitCols * 1.6);

  await context.close();
});

async function serverCols(page: Page, terminalId: string): Promise<number> {
  const terminal = (await listTerminals(page)).find((t) => t.id === terminalId);
  return terminal?.cols ?? 0;
}

async function localCols(page: Page, terminalId: string): Promise<number> {
  return page.evaluate((tid) => {
    const map = (
      window as unknown as {
        __offdeskTerminals?: Map<string, { cols: number }>;
      }
    ).__offdeskTerminals;
    return map?.get(tid)?.cols ?? 0;
  }, terminalId);
}

test("workspace remains mounted when terminal events are delayed", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
  });
  const page = await context.newPage();

  await openApp(page);
  await resetMachineState(page);
  await takeControlFromHeader(page);
  await page.routeWebSocket(/\/ws\/events/, () => {});
  await page.reload({ waitUntil: "commit" });
  await page
    .getByTestId("tab-bar")
    .waitFor({ state: "visible", timeout: 20_000 });
  await selectHomeWorkpath(page);

  await page.getByTestId("empty-new-terminal").click();

  await expect(getExpandedOverlay(page)).toBeVisible();
  await expect(page.locator("[data-testid^='workspace-pane-']")).toHaveCount(1);

  await context.close();
});

test("prefix keys focus panes by direction from the terminal", async ({
  page,
}) => {
  await openApp(page);
  await resetMachineState(page);
  await takeControlFromHeader(page);

  const firstId = await createTerminalViaApi(page, { cwd: "/root" });
  await expandTerminalById(page, firstId);
  await pressPrefixKey(page, "Shift+Digit5");
  await expect.poll(async () => (await listTerminals(page)).length).toBe(2);

  const secondId = (await listTerminals(page)).find(
    (terminal) => terminal.id !== firstId,
  )!.id;
  await expect(page.getByTestId(`workspace-pane-${secondId}`)).toHaveCSS(
    "box-shadow",
    /rgb/,
  );

  await pressPrefixKey(page, "ArrowLeft");
  await expect(page.getByTestId(`workspace-pane-${firstId}`)).toHaveCSS(
    "box-shadow",
    /rgb/,
  );
  await expect(page.getByTestId(`workspace-pane-${secondId}`)).toHaveCSS(
    "box-shadow",
    "none",
  );

  await pressPrefixKey(page, "ArrowRight");
  await expect(page.getByTestId(`workspace-pane-${secondId}`)).toHaveCSS(
    "box-shadow",
    /rgb/,
  );
});

test("desktop workspace restores pane layout after reload", async ({ page }) => {
  await openApp(page);
  await resetMachineState(page);
  await takeControlFromHeader(page);

  const firstId = await createTerminalViaApi(page, { cwd: "/root" });
  await expandTerminalById(page, firstId);
  await pressPrefixKey(page, "Shift+Digit5");
  await expect.poll(async () => (await listTerminals(page)).length).toBe(2);
  const firstSplitTerminals = await listTerminals(page);
  const secondId = firstSplitTerminals.find(
    (terminal) => terminal.id !== firstId,
  )!.id;

  await page.getByTestId(`workspace-pane-${firstId}`).hover();
  await pressPrefixKey(page, "Shift+Quote");
  await expect.poll(async () => (await listTerminals(page)).length).toBe(3);
  const thirdId = (await listTerminals(page)).find(
    (terminal) =>
      terminal.id !== firstId && terminal.id !== secondId,
  )!.id;
  const expectedOrder = [firstId, thirdId, secondId];

  await expect.poll(() => paneOrder(page)).toEqual(expectedOrder);
  // Panes are saved under the tab the hub opened for the first terminal.
  const groupKey = (await listTerminals(page)).find(
    (terminal) => terminal.id === firstId,
  )!.workspace_group_id!;
  expect(groupKey).toBeTruthy();
  await expect
    .poll(() => savedPaneOrder(page, groupKey), { timeout: 5_000 })
    .toEqual(expectedOrder);

  await page.reload();
  await page
    .getByTestId("tab-bar")
    .waitFor({ state: "visible", timeout: 20_000 });
  await expect(getExpandedOverlay(page)).toBeVisible();
  await expect(page.locator("[data-testid^='workspace-pane-']")).toHaveCount(3);
  await expect.poll(() => paneOrder(page)).toEqual(expectedOrder);
  const reloadedFirstBox = await paneBox(page, firstId);
  const reloadedThirdBox = await paneBox(page, thirdId);
  const reloadedSecondBox = await paneBox(page, secondId);
  expect(Math.abs(reloadedThirdBox.x - reloadedFirstBox.x)).toBeLessThan(8);
  expect(reloadedThirdBox.y).toBeGreaterThan(
    reloadedFirstBox.y + reloadedFirstBox.height * 0.5,
  );
  expect(reloadedSecondBox.x).toBeGreaterThan(
    reloadedFirstBox.x + reloadedFirstBox.width * 0.5,
  );
  expect(Math.abs(reloadedSecondBox.y - reloadedFirstBox.y)).toBeLessThan(8);
});

async function paneBox(page: Page, terminalId: string) {
  const box = await page
    .getByTestId(`workspace-pane-${terminalId}`)
    .boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

async function paneTerminalScale(page: Page, terminalId: string) {
  const scale = await page
    .getByTestId(`workspace-pane-${terminalId}`)
    .locator("[data-terminal-view-scale]")
    .first()
    .getAttribute("data-terminal-view-scale");
  return Number(scale);
}

async function paneXtermScrollbarWidth(page: Page, terminalId: string) {
  return page
    .getByTestId(`workspace-pane-${terminalId}`)
    .locator(".xterm-viewport")
    .first()
    .evaluate((element) => getComputedStyle(element).scrollbarWidth);
}

async function paneOrder(page: Page): Promise<string[]> {
  return page
    .locator("[data-testid^='workspace-pane-']")
    .evaluateAll((elements) =>
      elements.map((element) =>
        (element.getAttribute("data-testid") ?? "").replace(
          "workspace-pane-",
          "",
        ),
      ),
    );
}

async function savedPaneOrder(page: Page, groupKey: string): Promise<string[]> {
  const response = await page.request.get("/api/bootstrap", {
    headers: await getAuthHeaders(page),
  });
  expect(response.ok()).toBeTruthy();
  const snapshot = await response.json();
  const layout = snapshot.workspace_layouts?.find(
    (candidate: { machine_id: string; group_key: string }) =>
      candidate.machine_id === "e2e-node" && candidate.group_key === groupKey,
  );
  return collectLayoutIds(layout?.root ?? null);
}

function collectLayoutIds(root: unknown): string[] {
  if (!root || typeof root !== "object") return [];
  const node = root as {
    type?: string;
    terminalId?: string;
    first?: unknown;
    second?: unknown;
  };
  if (node.type === "leaf" && node.terminalId) return [node.terminalId];
  if (node.type !== "split") return [];
  return [
    ...collectLayoutIds(node.first),
    ...collectLayoutIds(node.second),
  ];
}
