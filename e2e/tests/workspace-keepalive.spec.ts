import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  createTerminalViaApi,
  createWorkspaceGroupViaApi,
  expandTerminalById,
  openApp,
  readTerminalBuffer,
  resetMachineState,
  takeControlFromHeader,
} from "./helpers";

// Workspace group keep-alive: the previously active group stays mounted but
// hidden, so flipping back does not rebuild xterm + WS + tmux attach. At most
// ONE inactive group is kept — a third activation evicts the oldest, which
// then re-attaches on switch-back.
//
// Two hooks installed by the init script below prove this without touching
// .xterm-rows: __wsOpenCount counts WebSocket constructions per
// /ws/terminal/ URL (a re-attach means a re-mount), and __wsInputByUrl logs
// every {type:"input"} payload per socket URL (same wrapping pattern as
// mobile-ime-composition.spec.ts, but keyed per socket). Buffer reads go
// through the __offdeskTerminals xterm instances (translateToString).

test.use({ viewport: { width: 1440, height: 960 } });

interface WsTrackerWindow {
  __wsOpenCount?: Record<string, number>;
  __wsInputByUrl?: Record<string, string[]>;
}

async function installWsTracker(page: Page): Promise<void> {
  await page.context().addInitScript(() => {
    const win = window as unknown as WsTrackerWindow;
    win.__wsOpenCount = {};
    win.__wsInputByUrl = {};
    const OriginalWebSocket = window.WebSocket;
    window.WebSocket = class extends OriginalWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        const key = String(url);
        if (key.includes("/ws/terminal/")) {
          win.__wsOpenCount![key] = (win.__wsOpenCount![key] ?? 0) + 1;
          win.__wsInputByUrl![key] = win.__wsInputByUrl![key] ?? [];
        }
      }
    };
    const originalSend = OriginalWebSocket.prototype.send;
    OriginalWebSocket.prototype.send = function (
      this: WebSocket,
      data: string | ArrayBufferLike | Blob | ArrayBufferView,
    ) {
      const key = this.url;
      if (key.includes("/ws/terminal/") && typeof data === "string") {
        try {
          const payload = JSON.parse(data) as {
            type?: string;
            data?: string;
          };
          if (payload?.type === "input" && typeof payload.data === "string") {
            win.__wsInputByUrl![key] = win.__wsInputByUrl![key] ?? [];
            win.__wsInputByUrl![key].push(payload.data);
          }
        } catch {
          // Not a JSON control message — ignore.
        }
      }
      return originalSend.call(this, data);
    };
  });
}

async function wsOpenCount(page: Page, terminalId: string): Promise<number> {
  return page.evaluate((tid) => {
    const counts = (window as unknown as WsTrackerWindow).__wsOpenCount ?? {};
    return Object.entries(counts)
      .filter(([url]) => url.includes(tid))
      .reduce((total, [, count]) => total + count, 0);
  }, terminalId);
}

async function wsInputFor(page: Page, terminalId: string): Promise<string[]> {
  return page.evaluate((tid) => {
    const logs = (window as unknown as WsTrackerWindow).__wsInputByUrl ?? {};
    return Object.entries(logs)
      .filter(([url]) => url.includes(tid))
      .flatMap(([, entries]) => entries);
  }, terminalId);
}

async function clearWsInput(page: Page, terminalId: string): Promise<void> {
  await page.evaluate((tid) => {
    const logs = (window as unknown as WsTrackerWindow).__wsInputByUrl ?? {};
    for (const url of Object.keys(logs)) {
      if (url.includes(tid)) logs[url] = [];
    }
  }, terminalId);
}

// Focus xterm through the terminal instance (same approach as
// mobile-ime-composition.spec.ts) — a pane click does not reliably land on
// the hidden textarea.
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

test("inactive group stays mounted for instant switch-back, capped at one", async ({
  page,
}) => {
  test.setTimeout(120_000);

  await installWsTracker(page);
  await openApp(page);
  await resetMachineState(page);
  await takeControlFromHeader(page);

  const groupA = await createWorkspaceGroupViaApi(page, `Keep A ${Date.now()}`);
  const groupB = await createWorkspaceGroupViaApi(page, `Keep B ${Date.now()}`);
  const terminalA = await createTerminalViaApi(page, {
    cwd: "/root",
    workspaceGroupId: groupA.id,
  });
  const terminalB = await createTerminalViaApi(page, {
    cwd: "/tmp",
    workspaceGroupId: groupB.id,
  });

  await expandTerminalById(page, terminalA);
  await expect(page.getByTestId(`workspace-pane-${terminalA}`)).toBeVisible();
  await expect
    .poll(() => wsOpenCount(page, terminalA), { timeout: 15_000 })
    .toBeGreaterThan(0);
  await expect
    .poll(() => readTerminalBuffer(page, terminalA), { timeout: 15_000 })
    .toMatch(/#\s*$/);
  await focusTerminal(page, terminalA);
  await page.keyboard.type("echo KEEPALIVE_MARKER_A");
  await page.keyboard.press("Enter");
  await expect
    .poll(() => readTerminalBuffer(page, terminalA), { timeout: 15_000 })
    .toContain("KEEPALIVE_MARKER_A");
  const opensABefore = await wsOpenCount(page, terminalA);

  // Switch to B: A stays mounted but hidden.
  await page.getByTestId(`workspace-group-${groupB.id}`).click();
  await expect(page.getByTestId(`workspace-pane-${terminalB}`)).toBeVisible();
  await expect(page.getByTestId(`workspace-pane-${terminalA}`)).toBeHidden();
  await expect
    .poll(() => readTerminalBuffer(page, terminalB), { timeout: 15_000 })
    .toMatch(/#\s*$/);
  await focusTerminal(page, terminalB);
  await page.keyboard.type("echo MARKER_B");
  await page.keyboard.press("Enter");
  await expect
    .poll(() => readTerminalBuffer(page, terminalB), { timeout: 15_000 })
    .toContain("MARKER_B");

  // Switch back to A: the kept-alive buffer shows the marker immediately
  // (direct read, no poll — a remount would start from an empty buffer).
  await page.getByTestId(`workspace-group-${groupA.id}`).click();
  await expect(page.getByTestId(`workspace-pane-${terminalA}`)).toBeVisible();
  expect(await readTerminalBuffer(page, terminalA)).toContain(
    "KEEPALIVE_MARKER_A",
  );
  // Kept alive, not re-attached: no new terminal WS for A. Give a re-attach
  // a moment to happen before concluding the count is stable.
  await page.waitForTimeout(1_000);
  expect(await wsOpenCount(page, terminalA)).toBe(opensABefore);

  // While B is hidden, typing reaches A's socket only — never B's.
  await clearWsInput(page, terminalB);
  await focusTerminal(page, terminalA);
  await page.keyboard.type("echo STILL_ON_A");
  await page.keyboard.press("Enter");
  await expect
    .poll(() => readTerminalBuffer(page, terminalA), { timeout: 15_000 })
    .toContain("STILL_ON_A");
  expect(await wsInputFor(page, terminalB)).toEqual([]);

  // Cap of one hidden group: the LRU keeps [active, previous], so activating
  // C keeps A (mounted [C, A]). A is only evicted by one more switch — to B
  // (mounted [B, C]) — after which switching back to A re-attaches (WS
  // construction count increases).
  const groupC = await createWorkspaceGroupViaApi(page, `Keep C ${Date.now()}`);
  const terminalC = await createTerminalViaApi(page, {
    cwd: "/var",
    workspaceGroupId: groupC.id,
  });
  await page.getByTestId(`workspace-group-${groupC.id}`).click();
  await expect(page.getByTestId(`workspace-pane-${terminalC}`)).toBeVisible();
  await page.getByTestId(`workspace-group-${groupB.id}`).click();
  await expect(page.getByTestId(`workspace-pane-${terminalB}`)).toBeVisible();
  // Evicted: A's pane is fully unmounted, not just hidden.
  await expect(page.getByTestId(`workspace-pane-${terminalA}`)).toHaveCount(0);
  await page.getByTestId(`workspace-group-${groupA.id}`).click();
  await expect(page.getByTestId(`workspace-pane-${terminalA}`)).toBeVisible();
  await expect
    .poll(() => wsOpenCount(page, terminalA), { timeout: 15_000 })
    .toBeGreaterThan(opensABefore);
});

// Hovering a tab switches to its group. A group that isn't mounted is built
// fresh (xterm, socket, tmux attach), blank for a round trip; the group on
// screen stays over it until it has drawn. Sample every frame of the switch:
// the incoming terminal is either under the held group or already drawn.
test("hovering to a group that isn't mounted never shows it blank", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openApp(page);
  await resetMachineState(page);
  await takeControlFromHeader(page);

  const groupA = await createWorkspaceGroupViaApi(page, `Hold A ${Date.now()}`);
  const groupB = await createWorkspaceGroupViaApi(page, `Hold B ${Date.now()}`);
  const terminalA = await createTerminalViaApi(page, {
    cwd: "/root",
    workspaceGroupId: groupA.id,
  });
  const terminalB = await createTerminalViaApi(page, {
    cwd: "/tmp",
    workspaceGroupId: groupB.id,
  });
  await expandTerminalById(page, terminalA);
  await expect
    .poll(() => readTerminalBuffer(page, terminalA), { timeout: 15_000 })
    .toMatch(/#\s*$/);
  await expect(page.getByTestId(`workspace-pane-${terminalB}`)).toHaveCount(0);

  await page.evaluate((target) => {
    type Term = {
      buffer: {
        active: {
          length: number;
          getLine: (i: number) => { translateToString: (trim: boolean) => string } | undefined;
        };
      };
    };
    const w = window as unknown as {
      __offdeskTerminals?: Map<string, Term>;
      __groupFrames?: { held: boolean; blank: boolean; settled: boolean }[];
    };
    const frames: { held: boolean; blank: boolean; settled: boolean }[] = [];
    w.__groupFrames = frames;
    const sample = () => {
      const held = document.querySelector("[data-held='true']") !== null;
      const term = w.__offdeskTerminals?.get(target);
      let drawn = false;
      if (term) {
        const buf = term.buffer.active;
        for (let i = 0; i < buf.length && !drawn; i++) {
          drawn = (buf.getLine(i)?.translateToString(true) ?? "").trim() !== "";
        }
      }
      const settled = Boolean(term) && drawn && !held;
      frames.push({ held, blank: Boolean(term) && !held && !drawn, settled });
      if (!settled && frames.length < 3000) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, terminalB);

  await page.getByTestId(`workspace-tab-${groupB.id}`).hover();
  const frames = () =>
    page.evaluate(
      () =>
        (window as unknown as { __groupFrames: { held: boolean; blank: boolean; settled: boolean }[] })
          .__groupFrames,
    );
  await expect
    .poll(async () => (await frames()).at(-1)?.settled ?? false, { timeout: 20_000 })
    .toBe(true);
  const sampled = await frames();
  expect(sampled.filter((frame) => frame.blank)).toHaveLength(0);
  expect(sampled.some((frame) => frame.held)).toBe(true);
  // Swapped: the incoming group is on screen, the outgoing one hidden.
  await expect(page.getByTestId(`workspace-pane-${terminalA}`)).toBeHidden();
  await expect(page.locator("[data-held='true']")).toHaveCount(0);
});
