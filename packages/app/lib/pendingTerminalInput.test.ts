import { describe, expect, it } from "vitest";

import { createPendingTerminalInput } from "./pendingTerminalInput";

function setup(options: { maxChars?: number; maxAgeMs?: number } = {}) {
  let time = 1_000;
  const queue = createPendingTerminalInput({ now: () => time, ...options });
  return {
    queue,
    advance(ms: number) {
      time += ms;
    },
  };
}

describe("createPendingTerminalInput", () => {
  it("starts empty and drains to an empty string", () => {
    const { queue } = setup();
    expect(queue.isEmpty).toBe(true);
    expect(queue.size).toBe(0);
    expect(queue.drain()).toBe("");
  });

  it("drains every push in order and empties the queue", () => {
    const { queue } = setup();
    queue.push("ec");
    queue.push("ho");
    queue.push(" hi");
    expect(queue.isEmpty).toBe(false);
    expect(queue.size).toBe(7);
    expect(queue.drain()).toBe("echo hi");
    expect(queue.isEmpty).toBe(true);
    expect(queue.size).toBe(0);
    expect(queue.drain()).toBe("");
  });

  it("ignores empty pushes", () => {
    const { queue } = setup();
    queue.push("");
    expect(queue.isEmpty).toBe(true);
  });

  it("accepts a push that lands exactly on the cap", () => {
    const { queue } = setup({ maxChars: 4 });
    queue.push("ab");
    queue.push("cd");
    expect(queue.size).toBe(4);
    expect(queue.drain()).toBe("abcd");
  });

  it("refuses the push that would cross the cap and keeps the prefix", () => {
    const { queue } = setup({ maxChars: 4 });
    queue.push("abc");
    queue.push("de");
    expect(queue.drain()).toBe("abc");
  });

  it("refuses every later push once the cap is hit, so nothing is reordered", () => {
    const { queue } = setup({ maxChars: 4 });
    queue.push("ab");
    queue.push("cdef");
    queue.push("g");
    expect(queue.size).toBe(2);
    expect(queue.drain()).toBe("ab");
  });

  it("accepts input again after a drain", () => {
    const { queue } = setup({ maxChars: 4 });
    queue.push("abcd");
    queue.push("e");
    expect(queue.drain()).toBe("abcd");
    queue.push("e");
    expect(queue.drain()).toBe("e");
  });

  it("drops everything when the oldest entry is older than the max age", () => {
    const { queue, advance } = setup({ maxAgeMs: 10_000 });
    queue.push("old");
    advance(9_000);
    queue.push("new");
    advance(1_001);
    expect(queue.drain()).toBe("");
    expect(queue.isEmpty).toBe(true);
  });

  it("replays input whose oldest entry is exactly at the max age", () => {
    const { queue, advance } = setup({ maxAgeMs: 10_000 });
    queue.push("ok");
    advance(10_000);
    expect(queue.drain()).toBe("ok");
  });

  it("measures age from the first push after the queue was emptied", () => {
    const { queue, advance } = setup({ maxAgeMs: 10_000 });
    queue.push("a");
    expect(queue.drain()).toBe("a");
    advance(20_000);
    queue.push("b");
    advance(5_000);
    expect(queue.drain()).toBe("b");
  });

  it("clear() empties the queue and resets the cap latch", () => {
    const { queue } = setup({ maxChars: 2 });
    queue.push("ab");
    queue.push("c");
    queue.clear();
    expect(queue.isEmpty).toBe(true);
    queue.push("xy");
    expect(queue.drain()).toBe("xy");
  });
});
