import { test, expect, devices, type Page } from "@playwright/test";
import { createTerminalViaApi, mobileTakeControl, openApp, resetMachineState } from "./helpers";

test.use({ ...devices["iPhone 14"], browserName: "chromium" });

// Claude Code breaks a word longer than a row at the right edge itself and
// goes on after the paragraph's indent; the terminal does not mark the rows
// as wrapped. Redrawn on every resize so the break sits at the final width;
// the subshell keeps the loop in the foreground job that gets SIGWINCH.
const TOKEN = "/tmp/e2e-select/a-long-path-that-the-app-breaks-at-the-right-edge.txt";
const DRAW =
  `n=$(( $(stty size | cut -d' ' -f2) - 7 )); ` +
  `printf '  echo %s\\n  %s\\n' "$(printf %s '${TOKEN}' | cut -c1-$n)" "$(printf %s '${TOKEN}' | cut -c$((n + 1))-)"`;

test("select mode copies a command broken over two rows as one line", async ({ page }) => {
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
        return rows.some((line) => line.startsWith("  echo /tmp/") && line.length === cols);
      },
      { timeout: 15_000 },
    )
    .toBe(true);

  await page.getByTestId("extended-keybar-select-toggle").click();
  const overlay = page.getByTestId("terminal-select-overlay");
  await expect(overlay).toContainText(`  echo ${TOKEN}`);
  const copied = await overlay.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    return selection.toString();
  });
  expect(copied.trim()).toBe(`echo ${TOKEN}`);
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
