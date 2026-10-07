import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { sanitizeFilename, saveDownloadedFile } from "./saveDownload";

interface FakeLink { href: string; download: string; style: Record<string, string>; click: () => void; remove: () => void }
let links: FakeLink[] = [];
const win: Record<string, unknown> = {};

const input = { filename: "a.txt", mime: "text/plain", dataBase64: btoa("hello") };

describe("sanitizeFilename", () => {
  it("replaces separators and control characters", () => {
    expect(sanitizeFilename("../x/y\\z.txt")).toBe(".._x_y_z.txt");
    expect(sanitizeFilename("a\nb")).toBe("a_b");
  });
  it("never returns an empty or dots-only name", () => {
    expect(sanitizeFilename("")).toBe("download");
    expect(sanitizeFilename("..")).toBe("download");
    expect(sanitizeFilename("  ")).toBe("download");
  });
  it("caps the length", () => {
    expect(sanitizeFilename("x".repeat(500)).length).toBe(200);
  });
});

describe("saveDownloadedFile", () => {
  beforeEach(() => {
    invoke.mockReset();
    vi.useFakeTimers();
    links = [];
    for (const k of Object.keys(win)) delete win[k];
    vi.stubGlobal("window", win);
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (X11; Linux)" });
    vi.stubGlobal("document", {
      body: { appendChild: vi.fn() },
      createElement: () => {
        const link: FakeLink = { href: "", download: "", style: {}, click: vi.fn(), remove: vi.fn() };
        links.push(link);
        return link;
      },
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("downloads through an anchor in the browser", async () => {
    const created: Blob[] = [];
    const createObjectURL = vi.fn((b: Blob) => (created.push(b), "blob:x"));
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    const saved = await saveDownloadedFile({ ...input, filename: "../a.txt" });
    expect(saved.location).toBe("浏览器下载");
    expect(saved.open).toBeUndefined();
    expect(links[0].download).toBe(".._a.txt");
    expect(links[0].href).toBe("blob:x");
    expect(links[0].click).toHaveBeenCalledOnce();
    expect(created[0].size).toBe(5);
    expect(created[0].type).toBe("text/plain");
    expect(invoke).not.toHaveBeenCalled();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:x");
  });

  it("invokes the native command inside Tauri and can reveal the file", async () => {
    win.__TAURI_INTERNALS__ = {};
    invoke.mockResolvedValueOnce({ path: "/home/u/Downloads/a.txt", uri: null });
    const saved = await saveDownloadedFile(input);
    expect(invoke).toHaveBeenCalledWith("save_download", {
      filename: "a.txt",
      mime: "text/plain",
      dataBase64: input.dataBase64,
    });
    expect(saved.location).toBe("/home/u/Downloads/a.txt");
    invoke.mockResolvedValueOnce(undefined);
    await saved.open!();
    expect(invoke).toHaveBeenLastCalledWith("open_download", {
      path: "/home/u/Downloads/a.txt",
      uri: null,
      mime: "text/plain",
    });
  });

  it("falls back to the browser on iOS", async () => {
    win.__TAURI_INTERNALS__ = {};
    vi.stubGlobal("navigator", { userAgent: "iPhone" });
    vi.stubGlobal("URL", { createObjectURL: () => "blob:i", revokeObjectURL: vi.fn() });
    const saved = await saveDownloadedFile(input);
    expect(saved.location).toBe("浏览器下载");
    expect(invoke).not.toHaveBeenCalled();
  });
});
