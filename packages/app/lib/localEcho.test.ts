import { describe, expect, it } from "vitest";

import { createLocalEchoController } from "./localEcho";

const normal = (col = 4, row = 2, cols = 80) => ({
  col,
  row,
  cols,
  alternateScreen: false,
});

describe("createLocalEchoController", () => {
  it("stays dormant on low-RTT local/LAN connections", () => {
    let now = 0;
    const echo = createLocalEchoController(() => now);
    echo.onInput("a", normal(), now);
    now += 10;
    const after = echo.onOutput(new TextEncoder().encode("a"), now);
    expect(after.active).toBe(false);
    expect(after.rttMs).toBe(10);

    const next = echo.onInput("b", normal(5), now);
    expect(next.text).toBe("");
  });

  it("activates on high-RTT links, predicts ASCII + backspace, and advances on exact echo", () => {
    let now = 0;
    const echo = createLocalEchoController(() => now);
    // Warm up RTT above 35ms threshold
    echo.onInput("x", normal(), now);
    now += 90;
    const warmed = echo.onOutput(new TextEncoder().encode("x"), now);
    expect(warmed.active).toBe(true);

    // Type "hi!" ahead of server echo
    expect(echo.onInput("h", normal(5), now).text).toBe("h");
    expect(echo.onInput("i", normal(5), now + 10).text).toBe("hi");
    expect(echo.onInput("!", normal(5), now + 20).text).toBe("hi!");
    // Backspace pops local prediction
    expect(echo.onInput("\x7f", normal(5), now + 30).text).toBe("hi");

    // Partial echo "h" advances startCol without flickering "i"
    const partial = echo.onOutput(new TextEncoder().encode("h"), now + 80);
    expect(partial.text).toBe("i");
    expect(partial.startCol).toBe(6);

    // Remaining echo "i" finishes cleanly
    const done = echo.onOutput(new TextEncoder().encode("i"), now + 95);
    expect(done.text).toBe("");
  });

  it("clears immediately on alternate screen, control keys, non-matching output, or TTL expiry", () => {
    let now = 0;
    const echo = createLocalEchoController(() => now);
    echo.onInput("a", normal(), now);
    now += 100;
    echo.onOutput(new TextEncoder().encode("a"), now);
    expect(echo.snapshot(now).active).toBe(true);

    // Alternate screen never predicts
    expect(
      echo.onInput("j", { col: 0, row: 0, cols: 80, alternateScreen: true }, now).text,
    ).toBe("");

    // Control key clears prediction
    echo.onInput("a", normal(2), now);
    expect(echo.onInput("\r", normal(2), now).text).toBe("");

    // Escape sequence from server clears prediction
    echo.onInput("b", normal(2), now);
    expect(echo.onOutput(new TextEncoder().encode("\x1b[2K"), now + 50).text).toBe("");

    // Unconfirmed prediction expires after TTL (e.g. password prompt)
    echo.onInput("s", normal(2), now + 100);
    expect(echo.snapshot(now + 100).text).toBe("s");
    expect(echo.snapshot(now + 2000).text).toBe("");
  });
});
