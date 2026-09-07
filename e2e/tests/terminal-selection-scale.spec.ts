import { expect, test, type Page } from "@playwright/test";

import {
  createTerminalViaApi,
  expandTerminalById,
  getImmersiveTerminal,
  openApp,
  resetMachineState,
  selectHomeWorkpath,
  takeControlFromHeader,
} from "./helpers";

for (const withShift of [true, false]) {
  test(`slightly transformed desktop terminal copies selection (shift=${withShift})`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 520 },
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      (window as unknown as { __selectionCopies: string[] }).__selectionCopies = [];
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            (window as unknown as { __selectionCopies: string[] })
              .__selectionCopies.push(text);
          },
        },
      });
    });

    await openApp(page);
    await resetMachineState(page);
    await takeControlFromHeader(page);
    await selectHomeWorkpath(page);

    const marker = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const terminalId = await createTerminalViaApi(page, {
      cwd: "/root",
      cols: 120,
      rows: 80,
      startupCommand: `printf '\\033[2J\\033[H${marker}\\n'; sleep 600`,
    });
    await expandTerminalById(page, terminalId);
    await expect(getImmersiveTerminal(page)).toBeVisible();
    await expect
      .poll(async () => readBufferLine(page, terminalId, 0))
      .toContain(marker);

    await page.evaluate(() => {
      const terminal = document.querySelector<HTMLElement>(
        "[data-terminal-display-mode='immersive']",
      );
      if (!terminal) throw new Error("immersive terminal is not mounted");
      terminal.style.transform = "scale(0.95)";
      terminal.style.transformOrigin = "top left";
    });

    const layout = await readScaledTerminalLayout(page);

    const targetText = marker.slice(0, 20);
    const start = cellPoint(layout, 0.1, 0.5);
    const end = cellPoint(layout, 20.1, 0.5);

    if (withShift) await page.keyboard.down("Shift");
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 8 });
    await page.mouse.up();
    if (withShift) await page.keyboard.up("Shift");

    if (withShift) {
      await expect.poll(() => readSelection(page, terminalId)).toBe(targetText);
    }

    await expect.poll(() => page.evaluate(() =>
      (window as unknown as { __selectionCopies: string[] })
        .__selectionCopies.at(-1),
    )).toBe(targetText);

    await context.close();
  });
}

async function readBufferLine(
  page: Page,
  terminalId: string,
  row: number,
): Promise<string> {
  return page.evaluate(
    ({ tid, rowIndex }) => {
      const map = (
        window as unknown as {
          __offdeskTerminals?: Map<
            string,
            {
              buffer: {
                active: {
                  getLine: (
                    index: number,
                  ) =>
                    | { translateToString: (trimRight: boolean) => string }
                    | undefined;
                };
              };
            }
          >;
        }
      ).__offdeskTerminals;
      return (
        map
          ?.get(tid)
          ?.buffer.active.getLine(rowIndex)
          ?.translateToString(true) ?? ""
      );
    },
    { tid: terminalId, rowIndex: row },
  );
}

async function readSelection(
  page: Page,
  terminalId: string,
): Promise<string> {
  return page.evaluate((tid) => {
    const map = (
      window as unknown as {
        __offdeskTerminals?: Map<string, { getSelection: () => string }>;
      }
    ).__offdeskTerminals;
    return map?.get(tid)?.getSelection() ?? "";
  }, terminalId);
}

async function readScaledTerminalLayout(page: Page): Promise<ScaledLayout> {
  return page.evaluate(() => {
    const root = document.querySelector(
      "[data-terminal-display-mode='immersive']",
    ) as HTMLElement | null;
    const screen = root?.querySelector(".xterm-screen") as HTMLElement | null;
    const map = (
      window as unknown as {
        __offdeskTerminals?: Map<string, { cols: number; rows: number }>;
      }
    ).__offdeskTerminals;
    const terminal = Array.from(map?.values() ?? [])[0];
    const rect = screen?.getBoundingClientRect();
    if (!root || !screen || !terminal || !rect) {
      throw new Error("terminal layout is not ready");
    }
    return {
      screen: {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      },
      cols: terminal.cols,
      rows: terminal.rows,
    };
  });
}

function cellPoint(layout: ScaledLayout, col: number, row: number): Point {
  return {
    x: layout.screen.left + (layout.screen.width / layout.cols) * col,
    y: layout.screen.top + (layout.screen.height / layout.rows) * row,
  };
}

interface ScaledLayout {
  screen: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
  cols: number;
  rows: number;
}

interface Point {
  x: number;
  y: number;
}
