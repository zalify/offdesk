import { describe, expect, it } from "vitest";

import { createTerminalClipboardProvider } from "./terminalClipboard";

type WriteSelection = Parameters<
  ReturnType<typeof createTerminalClipboardProvider>["writeText"]
>[0];
type ReadSelection = Parameters<
  ReturnType<typeof createTerminalClipboardProvider>["readText"]
>[0];

const SYSTEM_SELECTION = "c" as WriteSelection & ReadSelection;
const PRIMARY_SELECTION = "p" as WriteSelection & ReadSelection;

describe("createTerminalClipboardProvider", () => {
  it("writes OSC 52 system clipboard data through the app clipboard bridge", async () => {
    const writes: string[] = [];
    const provider = createTerminalClipboardProvider({
      readText: () => "",
      writeText: (text) => {
        writes.push(text);
      },
    });

    await provider.writeText(SYSTEM_SELECTION, "copied from tmux");

    expect(writes).toEqual(["copied from tmux"]);
  });

  it("writes tmux OSC 52 data with an omitted selection target", async () => {
    const writes: string[] = [];
    const provider = createTerminalClipboardProvider({
      readText: () => "",
      writeText: (text) => {
        writes.push(text);
      },
    });

    await provider.writeText("" as WriteSelection, "copied from tmux");

    expect(writes).toEqual(["copied from tmux"]);
  });

  it("ignores OSC 52 primary selection writes", async () => {
    const writes: string[] = [];
    const provider = createTerminalClipboardProvider({
      readText: () => "",
      writeText: (text) => {
        writes.push(text);
      },
    });

    await provider.writeText(PRIMARY_SELECTION, "primary selection");

    expect(writes).toEqual([]);
  });

  it("reads only the system clipboard", async () => {
    const provider = createTerminalClipboardProvider({
      readText: () => "current clipboard",
      writeText: () => {},
    });

    await expect(provider.readText(SYSTEM_SELECTION)).resolves.toBe(
      "current clipboard",
    );
    await expect(provider.readText(PRIMARY_SELECTION)).resolves.toBe("");
  });
});
