import { expect, type Download, type Page } from "@playwright/test";

/** Pointer position at the middle of `needle` in the visible terminal rows. */
export async function locate(page: Page, needle: string) {
  const target = await page.evaluate((text) => {
    const screen = document.querySelector(".xterm-screen") as HTMLElement;
    const rect = screen.getBoundingClientRect();
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
    if (!term) return null;
    const cw = rect.width / term.cols;
    const ch = rect.height / term.rows;
    const buf = term.buffer.active;
    // Last match: the shell echoes the startup command, which can contain
    // the same text higher up.
    for (let row = term.rows - 1; row >= 0; row--) {
      const line = buf.getLine(buf.viewportY + row)?.translateToString(true) ?? "";
      const index = line.indexOf(text);
      if (index < 0) continue;
      return {
        x: Math.round(rect.left + cw * (index + text.length / 2)),
        y: Math.round(rect.top + ch * (row + 0.5)),
      };
    }
    return null;
  }, needle);
  expect(target, `"${needle}" not on screen`).not.toBeNull();
  return target!;
}

export async function readDownload(download: Download) {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

