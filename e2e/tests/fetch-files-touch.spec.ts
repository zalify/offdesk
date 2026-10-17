import { test, expect, devices, type Page } from "@playwright/test";
import { createTerminalViaApi, mobileTakeControl, openApp, readTerminalBuffer, resetMachineState } from "./helpers";
import { locate, readDownload } from "./fetch-files.helpers";

test.use({ ...devices["iPhone 14"], browserName: "chromium" });

// WebView taps produce no mouse events, so links activate from touchend.
const tap = async (page: Page, needle: string) => {
  const { x, y } = await locate(page, needle);
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: string) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: type === "touchEnd" ? [] : [{ x, y, radiusX: 12, radiusY: 12, force: 1, id: 1 }],
    });
  const download = page.waitForEvent("download", { timeout: 15_000 });
  await touch("touchStart");
  await page.waitForTimeout(60);
  await touch("touchEnd");
  return download;
};

for (const [name, command, needle, filename, body] of [
  [
    "a bare path",
    `printf 'tap two\\n' > /tmp/e2e-tap-bare.txt; printf 'out: /tmp/e2e-tap-bare.txt\\n'; sleep 600`,
    "/tmp/e2e-tap-bare.txt",
    "e2e-tap-bare.txt",
    "tap two\n",
  ],
] as const) {
  test(`tapping ${name} downloads the file`, async ({ page }) => {
    await openApp(page);
    await resetMachineState(page);
    await mobileTakeControl(page);
    const id = await createTerminalViaApi(page, { cwd: "/tmp", startupCommand: command });
    await expect.poll(() => readTerminalBuffer(page, id)).toContain(needle);
    const download = await tap(page, needle);
    expect(download.suggestedFilename()).toBe(filename);
    expect(await readDownload(download)).toBe(body);
  });
}

// Claude Code breaks a long path at the right edge itself and goes on after
// the item's indent on the next row; nothing in the buffer ties the halves
// together. Redrawn on every resize so the break sits at the final width;
// the subshell keeps the loop in the foreground job that gets SIGWINCH.
const HEAD = "/tmp/e2e-wrap/hard-w"; // 20 columns
const TAIL = "rapped-path-file.txt";
const DRAW = `printf '%*s%s\\n  %s\\n' $(( $(stty size | cut -d' ' -f2) - 20 )) 'see ' '${HEAD}' '${TAIL}'`;

for (const [half, needle] of [
  ["second-row", TAIL],
  ["first-row", HEAD],
] as const) {
  test(`tapping the ${half} half of a path broken over two rows downloads it without the keyboard`, async ({ page }) => {
    await openApp(page);
    await resetMachineState(page);
    await mobileTakeControl(page);
    await createTerminalViaApi(page, {
      cwd: "/tmp",
      startupCommand: `mkdir -p /tmp/e2e-wrap; printf 'joined\\n' > /tmp/e2e-wrap/hard-wrapped-path-file.txt; (draw() { clear; ${DRAW}; }; trap draw WINCH; draw; while :; do sleep 1; done)`,
    });
    await expect
      .poll(
        async () => {
          const { cols, rows } = await screenRows(page);
          return rows.some((line) => line.endsWith(HEAD) && line.length === cols);
        },
        { timeout: 15_000 },
      )
      .toBe(true);

    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const download = await tap(page, needle);
    expect(download.suggestedFilename()).toBe("hard-wrapped-path-file.txt");
    expect(await readDownload(download)).toBe("joined\n");
    // The link took the tap: the terminal did not take focus (and the keyboard).
    expect(
      await page.evaluate(() => document.activeElement?.classList.contains("xterm-helper-textarea") ?? false),
    ).toBe(false);
  });
}

test("a path broken over two rows underlines its own cells, not the next row's indent", async ({ page }) => {
  await openApp(page);
  await resetMachineState(page);
  await mobileTakeControl(page);
  await createTerminalViaApi(page, {
    cwd: "/tmp",
    startupCommand: `(draw() { clear; ${DRAW}; }; trap draw WINCH; draw; while :; do sleep 1; done)`,
  });
  await expect
    .poll(
      async () => {
        const { cols, rows } = await screenRows(page);
        return rows.some((line) => line.endsWith(HEAD) && line.length === cols);
      },
      { timeout: 15_000 },
    )
    .toBe(true);

  const { x, y } = await locate(page, TAIL);
  await page.mouse.move(x, y);
  const bars = page.getByTestId("terminal-link-underline").locator("div");
  await expect(bars).toHaveCount(2);
  const [head, tail] = await bars.evaluateAll((els) =>
    els.map((el) => ({ left: el.offsetLeft, width: el.offsetWidth })),
  );
  // Both halves are 20 cells; the tail starts after the two-cell indent.
  const cell = tail.width / 20;
  expect(Math.round(tail.left / cell)).toBe(2);
  expect(Math.round(head.width / cell)).toBe(20);
  const { cols } = await screenRows(page);
  expect(Math.round((head.left + head.width) / cell)).toBe(cols);
});

async function screenRows(page: Page) {
  return page.evaluate(() => {
    const term = (
      window as unknown as {
        __offdeskTerminals?: Map<
          string,
          {
            cols: number;
            rows: number;
            buffer: {
              active: {
                viewportY: number;
                getLine(y: number): { translateToString(trim: boolean, start: number, end: number): string } | undefined;
              };
            };
          }
        >;
      }
    ).__offdeskTerminals?.values().next().value;
    if (!term) return { cols: 0, rows: [] as string[] };
    const buf = term.buffer.active;
    const rows: string[] = [];
    for (let row = 0; row < term.rows; row++) {
      // Rows can run past the edge after a resize; read what is on screen.
      rows.push(buf.getLine(buf.viewportY + row)?.translateToString(true, 0, term.cols) ?? "");
    }
    return { cols: term.cols, rows };
  });
}
