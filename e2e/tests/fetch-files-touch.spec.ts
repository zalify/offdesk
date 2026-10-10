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
    await expect.poll(() => screenRows(page).then((s) => s.rows.some((line) => line.endsWith(HEAD) && line.length === s.cols)), { timeout: 15_000 }).toBe(true);

    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const point = await locate(page, needle);
    let download;
    try {
      download = await tap(page, needle);
    } catch (err) {
      // TEMP diagnostics for CI
      const info = await page.evaluate(({ x, y }) => {
        const el = document.elementFromPoint(x, y) as HTMLElement | null;
        const notices = document.body.innerText.split("\n").filter((l) => /取|找不到|已保存|目录|失败/.test(l));
        return { under: el ? `${el.tagName}.${el.className} testid=${el.closest("[data-testid]")?.getAttribute("data-testid")}` : null, notices, active: document.activeElement?.className };
      }, point);
      const rows = await screenRows(page);
      throw new Error(`${String(err)}\nDIAG ${JSON.stringify({ point, info, cols: rows.cols, rows: rows.rows.slice(0, 4) })}`);
    }
    expect(download.suggestedFilename()).toBe("hard-wrapped-path-file.txt");
    expect(await readDownload(download)).toBe("joined\n");
    expect(
      await page.evaluate(() => document.activeElement?.classList.contains("xterm-helper-textarea") ?? false),
    ).toBe(false);
  });
}

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
                getLine(y: number): { translateToString(trim: boolean): string } | undefined;
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
      rows.push(buf.getLine(buf.viewportY + row)?.translateToString(true) ?? "");
    }
    return { cols: term.cols, rows };
  });
}
