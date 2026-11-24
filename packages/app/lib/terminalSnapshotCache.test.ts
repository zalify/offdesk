import { beforeEach, describe, expect, it } from "vitest";
import {
  captureTerminalSnapshot,
  clearAllTerminalSnapshots,
  clearTerminalSnapshot,
  getTerminalSnapshot,
  type SnapshotReadableTerminal,
} from "./terminalSnapshotCache";

function mockTerminal(lines: string[], viewportY = 0): SnapshotReadableTerminal {
  return {
    rows: lines.length,
    buffer: {
      active: {
        viewportY,
        getLine: (y) => {
          const text = lines[y - viewportY];
          if (text === undefined) return undefined;
          return {
            translateToString: (trimRight?: boolean) =>
              trimRight ? text.replace(/\s+$/, "") : text,
          };
        },
      },
    },
    options: { fontFamily: "JetBrains Mono", fontSize: 13 },
  };
}

describe("terminalSnapshotCache", () => {
  beforeEach(() => {
    clearAllTerminalSnapshots();
  });

  it("captures trimmed visible lines and retrieves them", () => {
    const snap = captureTerminalSnapshot(
      "t1",
      mockTerminal(["$ ls   ", "file.txt  ", "   ", ""]),
    );
    expect(snap).not.toBeNull();
    expect(snap?.lines).toEqual(["$ ls", "file.txt"]);
    expect(snap?.fontFamily).toBe("JetBrains Mono");
    expect(snap?.fontSize).toBe(13);
    expect(getTerminalSnapshot("t1")?.lines).toEqual(["$ ls", "file.txt"]);
  });

  it("returns null for completely blank screens", () => {
    const snap = captureTerminalSnapshot("empty", mockTerminal(["", "   "]));
    expect(snap).toBeNull();
    expect(getTerminalSnapshot("empty")).toBeNull();
  });

  it("clears individual snapshots", () => {
    captureTerminalSnapshot("t1", mockTerminal(["hello"]));
    clearTerminalSnapshot("t1");
    expect(getTerminalSnapshot("t1")).toBeNull();
  });

  it("evicts least recently used entries past capacity", () => {
    for (let i = 0; i < 70; i += 1) {
      captureTerminalSnapshot(`t-${i}`, mockTerminal([`line ${i}`]));
    }
    expect(getTerminalSnapshot("t-0")).toBeNull();
    expect(getTerminalSnapshot("t-69")?.lines).toEqual(["line 69"]);
  });
});
