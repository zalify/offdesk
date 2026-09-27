import { afterEach, expect, it, vi } from "vitest";
import { writeClipboardText } from "./writeClipboardText";

afterEach(() => vi.unstubAllGlobals());

it("writes handoff text through native IPC when available", async () => {
  const invoke = vi.fn().mockResolvedValue(undefined);
  const browserWrite = vi.fn();
  vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
  vi.stubGlobal("navigator", { clipboard: { writeText: browserWrite } });
  await writeClipboardText("literal instructions");
  expect(invoke).toHaveBeenCalledWith("plugin:clipboard-manager|write_text", { text: "literal instructions" });
  expect(browserWrite).not.toHaveBeenCalled();
});

it("falls back to the browser and reports a failure if neither clipboard works", async () => {
  vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke: vi.fn().mockRejectedValue(new Error("no plugin")) } });
  const browserWrite = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText: browserWrite } });
  await writeClipboardText("instructions");
  expect(browserWrite).toHaveBeenCalledWith("instructions");
  browserWrite.mockRejectedValue(new Error("denied"));
  await expect(writeClipboardText("instructions")).rejects.toThrow("denied");
});
