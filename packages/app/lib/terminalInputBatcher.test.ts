import { describe, expect, it } from "vitest";

import { createInputBatcher, isPureWheelInput } from "./terminalInputBatcher";

function createHarness() {
  const sent: string[] = [];
  const scheduled: (() => void)[] = [];
  const batcher = createInputBatcher(
    (data) => sent.push(data),
    (cb) => scheduled.push(cb),
  );
  const runScheduled = () => {
    scheduled.shift()?.();
  };
  return { batcher, sent, scheduled, runScheduled };
}

describe("createInputBatcher", () => {
  it("coalesces same-tick pushes into one send, preserving order", () => {
    const { batcher, sent, runScheduled } = createHarness();
    batcher.push("a");
    batcher.push("b");
    batcher.push("c");
    expect(sent).toEqual([]);
    runScheduled();
    expect(sent).toEqual(["abc"]);
  });

  it("flush() sends immediately and the scheduled flush becomes a no-op", () => {
    const { batcher, sent, scheduled, runScheduled } = createHarness();
    batcher.push("a");
    batcher.flush();
    expect(sent).toEqual(["a"]);
    expect(scheduled).toHaveLength(1);
    runScheduled();
    expect(sent).toEqual(["a"]);
  });

  it("starts a new batch for pushes after a flush", () => {
    const { batcher, sent, runScheduled } = createHarness();
    batcher.push("a");
    batcher.flush();
    batcher.push("b");
    runScheduled();
    expect(sent).toEqual(["a", "b"]);
  });

  it("sends a single push as the identical string", () => {
    const { batcher, sent, runScheduled } = createHarness();
    batcher.push("only");
    runScheduled();
    expect(sent).toEqual(["only"]);
  });

  it("coalesces wheel reports on the wheel scheduler and upgrades to immediate on keystrokes", () => {
    const sent: string[] = [];
    const immediate: (() => void)[] = [];
    const wheel: (() => void)[] = [];
    const batcher = createInputBatcher(
      (data) => sent.push(data),
      (cb) => immediate.push(cb),
      (cb) => wheel.push(cb),
    );
    const up = "\x1b[<64;10;10M";
    const down = "\x1b[<65;10;10M";
    expect(isPureWheelInput(up)).toBe(true);
    expect(isPureWheelInput(up + down)).toBe(true);
    expect(isPureWheelInput("a")).toBe(false);

    batcher.push(up);
    batcher.push(up);
    expect(immediate).toHaveLength(0);
    expect(wheel).toHaveLength(1);
    wheel.shift()?.();
    expect(sent).toEqual([up + up]);

    // A keystroke arriving while wheel reports are queued upgrades to immediate
    // flush and preserves strict order.
    batcher.push(down);
    batcher.push("x");
    expect(wheel).toHaveLength(1);
    expect(immediate).toHaveLength(1);
    immediate.shift()?.();
    expect(sent).toEqual([up + up, down + "x"]);
    // The stale wheel callback becomes a no-op.
    wheel.shift()?.();
    expect(sent).toEqual([up + up, down + "x"]);
  });
});
