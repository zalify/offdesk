import { expect, type Locator, type Page } from "@playwright/test";

const MACHINE_ID = "e2e-node";

async function authenticate(page: Page): Promise<void> {
  const response = await page.request.get("/api/auth/dev");
  expect(response.ok()).toBeTruthy();

  const { token } = await response.json();
  await page.context().addInitScript((value) => {
    localStorage.setItem("offdesk:token", value);
    // Opt-in to test-only hooks (e.g. the window.__offdeskTerminals map that
    // exposes live xterm instances for buffer inspection). Production builds
    // never set this flag and therefore never expose internals globally.
    localStorage.setItem("offdesk:e2e", "1");
  }, token);
}

/**
 * Open the app, authenticate, and wait for the new workbench shell to be
 * ready. Works for both desktop (TabBar + workspace) and mobile
 * (MobileWorkbench) layouts.
 */
export async function openApp(page: Page): Promise<void> {
  await authenticate(page);
  await page.goto("/");
  await Promise.race([
    page.getByTestId("tab-bar").waitFor({
      state: "visible",
      timeout: 20_000,
    }),
    page.getByTestId("mobile-workbench").waitFor({
      state: "visible",
      timeout: 20_000,
    }),
  ]);
}

export async function getAuthHeaders(page: Page): Promise<Record<string, string>> {
  const token = await page.evaluate(() => localStorage.getItem("offdesk:token"));
  expect(token).toBeTruthy();
  return {
    Authorization: `Bearer ${token}`,
  };
}

export async function getDeviceId(page: Page): Promise<string> {
  await page.waitForFunction(() => !!sessionStorage.getItem("tc-device-id"));
  const deviceId = await page.evaluate(() => sessionStorage.getItem("tc-device-id"));
  expect(deviceId).toBeTruthy();
  return deviceId!;
}

export interface ListedTerminal {
  id: string;
  machine_id: string;
  title: string;
  cwd: string;
  workspace_group_id?: string | null;
  cols: number;
  rows: number;
  reachable: boolean;
}

export async function listTerminals(page: Page): Promise<ListedTerminal[]> {
  const response = await page.request.get("/api/terminals", {
    headers: await getAuthHeaders(page),
  });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

/// Stable fields for cross-time/cross-page terminal comparisons. `title` and
/// `title_source` are intentionally dynamic (live OSC/process reporting), so
/// deep-equality on full objects races with the machine's 5s title ticks;
/// size-fidelity assertions compare these fields instead.
export function stableTerminalFields(terminal: ListedTerminal) {
  const { id, machine_id, cols, rows, cwd, reachable } = terminal;
  return { id, machine_id, cols, rows, cwd, reachable };
}

export async function requestMachineControl(page: Page): Promise<void> {
  const response = await page.request.post("/api/mode/control", {
    headers: await getAuthHeaders(page),
    data: {
      machine_id: MACHINE_ID,
      device_id: await getDeviceId(page),
    },
  });
  expect(response.ok()).toBeTruthy();
}

export async function releaseMachineControl(page: Page): Promise<void> {
  const response = await page.request.post("/api/mode/release", {
    headers: await getAuthHeaders(page),
    data: {
      machine_id: MACHINE_ID,
      device_id: await getDeviceId(page),
    },
  });
  // Server may respond with a 2xx regardless of whether a lease existed.
  expect(response.ok()).toBeTruthy();
}

export async function destroyAllTerminals(page: Page): Promise<void> {
  const headers = await getAuthHeaders(page);
  const deviceId = await getDeviceId(page);
  for (const terminal of await listTerminals(page)) {
    const response = await page.request.delete(
      `/api/machines/${terminal.machine_id}/terminals/${terminal.id}?device_id=${encodeURIComponent(deviceId)}`,
      { headers },
    );
    expect(response.ok()).toBeTruthy();
  }
}

export async function resetMachineState(page: Page): Promise<void> {
  await requestMachineControl(page);
  await destroyAllTerminals(page);
  await deleteAllWorkspaceGroups(page);
  await deleteAllWorkspaceLayouts(page);
  await expectTerminalCount(page, 0);
  // Release control via API (works on both desktop and mobile — mobile has no
  // control pill). Then wait for the UI to pick up the mode change so
  // follow-up assertions on the viewing pill land reliably.
  await releaseMachineControl(page);
  const tabBar = page.getByTestId("tab-bar");
  if (await tabBar.isVisible().catch(() => false)) {
    await expect(page.getByTestId("workbench-request-control")).toBeVisible();
  }
}

export async function deleteAllWorkspaceLayouts(page: Page): Promise<void> {
  const headers = await getAuthHeaders(page);
  const response = await page.request.get("/api/bootstrap", { headers });
  expect(response.ok()).toBeTruthy();
  const snapshot = await response.json();
  const layouts = (snapshot.workspace_layouts ?? []) as Array<{
    machine_id: string;
    group_key: string;
    updated_at?: number;
  }>;
  for (const layout of layouts) {
    if (layout.machine_id !== MACHINE_ID) continue;
    const deleteResponse = await page.request.put(
      `/api/machines/${MACHINE_ID}/workspace-layouts`,
      {
        headers,
        data: {
          group_key: layout.group_key,
          root: null,
          base_updated_at: layout.updated_at ?? -1,
        },
      },
    );
    expect(deleteResponse.ok()).toBeTruthy();
  }
}

export async function deleteAllWorkspaceGroups(page: Page): Promise<void> {
  const headers = await getAuthHeaders(page);
  for (const group of await listWorkspaceGroupsViaApi(page)) {
    const response = await page.request.delete(
      `/api/machines/${MACHINE_ID}/workspace-groups/${group.id}`,
      { headers },
    );
    expect(response.ok()).toBeTruthy();
  }
}

/**
 * The TabBar control affordance: a "viewing" pill that exists only while the
 * user is NOT the controller (controlling renders nothing — it's the normal
 * state). Clicking it requests control.
 */
export function getControlToggle(page: Page): Locator {
  return page.getByTestId("workbench-request-control");
}

export async function expectControlState(
  page: Page,
  state: "controlling" | "viewing",
): Promise<void> {
  const pill = page.getByTestId("workbench-request-control");
  if (state === "controlling") {
    await expect(pill).toHaveCount(0);
  } else {
    await expect(pill).toBeVisible();
  }
}

export async function takeControlFromHeader(page: Page): Promise<void> {
  await page.getByTestId("workbench-request-control").click();
  await expectControlState(page, "controlling");
}

export async function releaseControlFromHeader(page: Page): Promise<void> {
  // The desktop chrome has no release button — controlling renders no pill.
  // Release via the API and wait for the viewing pill to come back.
  await releaseMachineControl(page);
  await expectControlState(page, "viewing");
}

/**
 * Send a ⌃B prefix chord: arm the prefix engine with Ctrl+B, then press the
 * bound second key. Use Playwright modifier syntax for shifted symbols —
 * e.g. "Shift+Digit5" for ⌃B %, "Shift+Quote" for ⌃B ".
 */
export async function pressPrefixKey(page: Page, key: string): Promise<void> {
  await page.keyboard.press("Control+b");
  // Wait for the prefix to actually arm before sending the second key.
  // Arming is React state; on a loaded CI runner the second press can land
  // before the state lands, and the shortcut is dropped with no trace — the
  // pane count stays correct, so the only symptom is a missing side effect
  // several assertions later. The app already renders this indicator
  // whenever the prefix is armed; nothing was using it.
  await expect(page.getByTestId("prefix-armed-indicator")).toBeVisible();
  await page.keyboard.press(key);
}

/** Right-click a workspace pane and wait for the context menu to open. */
export async function openPaneContextMenu(
  page: Page,
  terminalId: string,
): Promise<void> {
  await page.getByTestId(`workspace-pane-${terminalId}`).click({
    button: "right",
  });
  await expect(page.getByTestId("context-menu")).toBeVisible();
}

/** Fit a pane to the workspace via its context menu. */
export async function fitPaneViaContextMenu(
  page: Page,
  terminalId: string,
): Promise<void> {
  await openPaneContextMenu(page, terminalId);
  await page.getByRole("menuitem", { name: "Fit to window" }).click();
  await expect(page.getByTestId("context-menu")).toHaveCount(0);
}

export async function selectAllWorkpath(page: Page): Promise<void> {
  // The desktop rail was removed; the default scope is already "all".
  void page;
}

export async function selectHomeWorkpath(page: Page): Promise<void> {
  // The desktop rail was removed; new terminals default to the home directory.
  void page;
}

/**
 * Create a terminal for the current machine in its home directory and return
 * the terminal id. Uses the REST API directly — faster and more deterministic
 * than the UI "New terminal" button, which auto-opens the expanded overlay.
 */
export async function createTerminalViaApi(
  page: Page,
  opts: {
    cwd?: string;
    startupCommand?: string;
    cols?: number;
    rows?: number;
    workspaceGroupId?: string | null;
  } = {},
): Promise<string> {
  const headers = await getAuthHeaders(page);
  const deviceId = await getDeviceId(page);
  const cwd = opts.cwd ?? "/root";
  const resp = await page.request.post(`/api/machines/${MACHINE_ID}/terminals`, {
    headers,
    data: {
      cwd,
      device_id: deviceId,
      ...(opts.startupCommand ? { startup_command: opts.startupCommand } : {}),
      ...(opts.cols !== undefined ? { cols: opts.cols } : {}),
      ...(opts.rows !== undefined ? { rows: opts.rows } : {}),
      ...(opts.workspaceGroupId !== undefined
        ? { workspace_group_id: opts.workspaceGroupId }
        : {}),
    },
  });
  expect(resp.ok()).toBeTruthy();
  return ((await resp.json()) as { id: string }).id;
}

export async function createWorkspaceGroupViaApi(
  page: Page,
  name: string,
): Promise<{ id: string; machine_id: string; name: string; sort_order: number }> {
  const response = await page.request.post(
    `/api/machines/${MACHINE_ID}/workspace-groups`,
    {
      headers: await getAuthHeaders(page),
      data: { name },
    },
  );
  expect(response.ok()).toBeTruthy();
  return response.json();
}

export async function listWorkspaceGroupsViaApi(
  page: Page,
): Promise<Array<{ id: string; machine_id: string; name: string; sort_order: number }>> {
  const response = await page.request.get(
    `/api/machines/${MACHINE_ID}/workspace-groups`,
    {
      headers: await getAuthHeaders(page),
    },
  );
  expect(response.ok()).toBeTruthy();
  return response.json();
}

export async function deleteWorkspaceGroupViaApi(
  page: Page,
  groupId: string,
): Promise<void> {
  const response = await page.request.delete(
    `/api/machines/${MACHINE_ID}/workspace-groups/${groupId}`,
    { headers: await getAuthHeaders(page) },
  );
  expect(response.ok()).toBeTruthy();
}

export async function expectTerminalCount(
  page: Page,
  count: number,
): Promise<void> {
  await expect.poll(async () => (await listTerminals(page)).length).toBe(count);
}

export function getExpandedOverlay(page: Page): Locator {
  return page.getByTestId("expanded-terminal");
}

export function getImmersiveTerminal(page: Page): Locator {
  // The TerminalCard in `tab` display mode (used inside the workspace)
  // carries a `data-terminal-display-mode="immersive"` marker via
  // TerminalView.web.
  return page.locator("[data-terminal-display-mode='immersive']").first();
}

async function focusTerminalByHash(page: Page, terminalId: string): Promise<void> {
  await page.evaluate((id) => {
    window.history.pushState(null, "", `#/t/${id}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, terminalId);
}

/**
 * Ensure the workspace is focused on the only (or first) terminal.
 * The workspace is now always visible when terminals exist, so this just
 * makes sure the correct terminal is active.
 */
export async function expandOnlyTerminal(page: Page): Promise<Locator> {
  const immersive = getImmersiveTerminal(page);
  if (await immersive.isVisible().catch(() => false)) {
    return immersive;
  }
  const terminals = await listTerminals(page);
  expect(terminals.length).toBeGreaterThan(0);
  await focusTerminalByHash(page, terminals[0].id);
  await expect(getExpandedOverlay(page)).toBeVisible();
  await expect(immersive).toBeVisible();
  return immersive;
}

export async function expandTerminalById(
  page: Page,
  terminalId: string,
): Promise<Locator> {
  await focusTerminalByHash(page, terminalId);
  await expect(getExpandedOverlay(page)).toBeVisible();
  return getImmersiveTerminal(page);
}

export async function getTerminalViewScale(page: Page): Promise<number> {
  const scale = await getImmersiveTerminal(page).getAttribute(
    "data-terminal-view-scale",
  );
  return Number(scale);
}

export async function getTerminalViewJustify(
  page: Page,
): Promise<string | null> {
  return getImmersiveTerminal(page).getAttribute("data-terminal-view-justify");
}

export async function readTerminalBuffer(
  page: Page,
  terminalId: string,
): Promise<string> {
  return page.evaluate((tid) => {
    const map = (
      window as unknown as { __offdeskTerminals?: Map<string, unknown> }
    ).__offdeskTerminals;
    const term = map?.get(tid) as
      | {
          buffer: {
            active: {
              length: number;
              getLine: (
                i: number,
              ) => { translateToString: (trim: boolean) => string } | undefined;
            };
          };
        }
      | undefined;
    if (!term) return "";
    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      lines.push(buf.getLine(i)?.translateToString(true) ?? "");
    }
    return lines.join("\n");
  }, terminalId);
}

/**
 * Mobile-specific: the host sheet (opened through the title bar's session
 * switcher header) carries the control toggle row — "Take control" while viewing,
 * "Stop control" while controlling. Tapping it closes the sheet.
 */
export async function mobileOpenHostSheet(page: Page): Promise<void> {
  await page.getByTestId("mobile-title-bar").click();
  await expect(page.getByTestId("mobile-session-switcher")).toBeVisible();
  await page.getByTestId("mobile-host-button").click();
  await expect(page.getByTestId("mobile-control-toggle")).toBeVisible();
}

export async function mobileTakeControl(page: Page): Promise<void> {
  await mobileOpenHostSheet(page);
  await page.getByTestId("mobile-control-toggle").click();
}

export async function mobileReleaseControl(page: Page): Promise<void> {
  await mobileOpenHostSheet(page);
  await page.getByTestId("mobile-control-toggle").click();
}

/**
 * Mobile-specific: long-press the title bar (touch held for 600ms)
 * to open its action sheet (Close terminal / New terminal here).
 */
export async function longPressTitleBar(page: Page): Promise<void> {
  const bar = page.getByTestId("mobile-title-bar");
  await bar.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const touch = new Touch({
      identifier: 7,
      target: element,
      clientX: x,
      clientY: y,
    });
    element.dispatchEvent(
      new TouchEvent("touchstart", {
        bubbles: true,
        cancelable: true,
        touches: [touch],
        targetTouches: [touch],
        changedTouches: [touch],
      }),
    );
  });
  await page.waitForTimeout(600);
  await bar.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const touch = new Touch({
      identifier: 7,
      target: element,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    });
    element.dispatchEvent(
      new TouchEvent("touchend", {
        bubbles: true,
        cancelable: true,
        touches: [],
        targetTouches: [],
        changedTouches: [touch],
      }),
    );
  });
}

export async function swipeTitleBar(
  page: Page,
  direction: "left" | "right",
): Promise<void> {
  await page.getByTestId("mobile-title-bar-label").evaluate(
    (element, swipeDirection) => {
      const rect = element.getBoundingClientRect();
      const startX =
        swipeDirection === "left" ? rect.right - 12 : rect.left + 12;
      const endX =
        swipeDirection === "left" ? rect.left + 12 : rect.right - 12;
      const y = rect.top + rect.height / 2;

      function dispatch(
        type: "touchstart" | "touchmove" | "touchend",
        x: number,
      ) {
        const touch = new Touch({
          identifier: 8,
          target: element,
          clientX: x,
          clientY: y,
        });
        element.dispatchEvent(
          new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            touches: type === "touchend" ? [] : [touch],
            targetTouches: type === "touchend" ? [] : [touch],
            changedTouches: [touch],
          }),
        );
      }

      dispatch("touchstart", startX);
      dispatch("touchmove", (startX + endX) / 2);
      dispatch("touchend", endX);
    },
    direction,
  );
}
