import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DirEntry } from "@offdesk/shared";
import { RemoteFileError } from "./api";
import {
  basename,
  blobToBase64,
  canBack,
  canForward,
  clipboardAfterPaste,
  createHistory,
  describeFsOpError,
  dirname,
  downloadRemote,
  MAX_DOWNLOAD_BYTES,
  downloadZip,
  emptySelection,
  entryKind,
  historyBack,
  historyCurrent,
  historyForward,
  historyPush,
  joinPath,
  moveFocus,
  pasteDecision,
  pinFolder,
  pinnedFolders,
  pruneSelection,
  selectAll,
  selectOne,
  selectRange,
  selectedPaths,
  setViewPrefs,
  sortEntries,
  toggleSelect,
  unpinFolder,
  uploadToDirectory,
  validateName,
  viewPrefs,
} from "./fileManager";
import type { UploadApi } from "./fileManager";

const entry = (name: string, is_dir = false, size?: number, modified_ms?: number): DirEntry => ({
  name,
  path: `/x/${name}`,
  is_dir,
  size,
  modified_ms,
});
const names = (es: DirEntry[]) => es.map((e) => e.name);
const order = ["a", "b", "c", "d", "e"];

describe("names", () => {
  it("validates like the node", () => {
    expect(validateName("ok.txt")).toBeNull();
    expect(validateName(".hidden")).toBeNull();
    expect(validateName("")).not.toBeNull();
    expect(validateName(".")).not.toBeNull();
    expect(validateName("..")).not.toBeNull();
    expect(validateName("a/b")).not.toBeNull();
    expect(validateName("a\0b")).not.toBeNull();
  });
  it("joins and splits paths", () => {
    expect(joinPath("/a", "b")).toBe("/a/b");
    expect(joinPath("/a/", "b")).toBe("/a/b");
    expect(joinPath("/", "b")).toBe("/b");
    expect(joinPath("~", "b")).toBe("~/b");
    expect(basename("/a/b.txt")).toBe("b.txt");
    expect(basename("/a/b/")).toBe("b");
    expect(basename("/")).toBe("/");
    expect(dirname("/a/b")).toBe("/a");
    expect(dirname("/a")).toBe("/");
    expect(dirname("~/a")).toBe("~");
    expect(dirname("~")).toBe("~");
    expect(dirname("a")).toBe("");
  });
});

describe("sortEntries", () => {
  const list = [
    entry("b.txt", false, 5, 30),
    entry("File10.md", false, 50, 10),
    entry("file2.md", false, 500, 20),
    entry("zdir", true),
    entry("Adir", true),
  ];
  it("name: folders first, natural, case-insensitive", () => {
    expect(names(sortEntries(list, { key: "name", dir: "asc" }))).toEqual([
      "Adir", "zdir", "b.txt", "file2.md", "File10.md",
    ]);
  });
  it("name desc keeps folders first", () => {
    expect(names(sortEntries(list, { key: "name", dir: "desc" }))).toEqual([
      "zdir", "Adir", "File10.md", "file2.md", "b.txt",
    ]);
  });
  it("size and modified", () => {
    expect(names(sortEntries(list, { key: "size", dir: "asc" })).slice(2)).toEqual([
      "b.txt", "File10.md", "file2.md",
    ]);
    expect(names(sortEntries(list, { key: "size", dir: "desc" })).slice(2)).toEqual([
      "file2.md", "File10.md", "b.txt",
    ]);
    expect(names(sortEntries(list, { key: "modified", dir: "desc" })).slice(2)).toEqual([
      "b.txt", "file2.md", "File10.md",
    ]);
  });
  it("kind groups by extension, name breaks ties", () => {
    expect(names(sortEntries(list, { key: "kind", dir: "asc" })).slice(2)).toEqual([
      "file2.md", "File10.md", "b.txt",
    ]);
    expect(entryKind(entry("x", true))).toBe("folder");
    expect(entryKind(entry("A.TXT"))).toBe("txt");
    expect(entryKind(entry(".bashrc"))).toBe("");
  });
  it("does not mutate the input", () => {
    const copy = [...list];
    sortEntries(list, { key: "name", dir: "asc" });
    expect(list).toEqual(copy);
  });
});

describe("selection", () => {
  const sel = (s: ReturnType<typeof emptySelection>) => [...s.selected];
  it("click replaces, toggle adds and removes", () => {
    let s = selectOne(emptySelection(), "b");
    s = toggleSelect(s, "d");
    expect(sel(s)).toEqual(["b", "d"]);
    s = toggleSelect(s, "b");
    expect(sel(s)).toEqual(["d"]);
    expect(s.anchor).toBe("b");
    expect(selectOne(s, "a").selected.size).toBe(1);
  });
  it("shift range runs from the anchor, either direction, anchor stays", () => {
    let s = selectOne(emptySelection(), "c");
    s = selectRange(s, order, "e");
    expect(sel(s)).toEqual(["c", "d", "e"]);
    s = selectRange(s, order, "a");
    expect(sel(s).sort()).toEqual(["a", "b", "c"]);
    expect(s.anchor).toBe("c");
    expect(s.focus).toBe("a");
  });
  it("shift range without an anchor selects just the target", () => {
    expect(sel(selectRange(emptySelection(), order, "d"))).toEqual(["d"]);
  });
  it("select all", () => {
    const s = selectAll(emptySelection(), order);
    expect(s.selected.size).toBe(5);
    expect(selectAll(emptySelection(), [])).toEqual(emptySelection());
  });
  it("arrows start at the ends when nothing is focused", () => {
    expect(moveFocus(emptySelection(), order, 1).focus).toBe("a");
    expect(moveFocus(emptySelection(), order, -1).focus).toBe("e");
    expect(moveFocus(emptySelection(), [], 1)).toEqual(emptySelection());
  });
  it("arrows clamp and replace the selection", () => {
    let s = selectOne(emptySelection(), "a");
    s = moveFocus(s, order, -1);
    expect(sel(s)).toEqual(["a"]);
    s = moveFocus(s, order, 1);
    expect(sel(s)).toEqual(["b"]);
    s = selectOne(s, "e");
    expect(sel(moveFocus(s, order, 1))).toEqual(["e"]);
  });
  it("shift+arrows extend and shrink around the anchor", () => {
    let s = selectOne(emptySelection(), "b");
    s = moveFocus(s, order, 1, true);
    s = moveFocus(s, order, 1, true);
    expect(sel(s)).toEqual(["b", "c", "d"]);
    s = moveFocus(s, order, -1, true);
    expect(sel(s)).toEqual(["b", "c"]);
    s = moveFocus(s, order, -1, true);
    s = moveFocus(s, order, -1, true);
    expect(sel(s).sort()).toEqual(["a", "b"]);
    expect(s.anchor).toBe("b");
  });
  it("shift+arrow without an anchor anchors at the focused row", () => {
    const s = moveFocus({ selected: new Set(), anchor: null, focus: "b" }, order, 1, true);
    expect(sel(s)).toEqual(["b", "c"]);
  });
  it("prunes vanished paths and keeps identity when unchanged", () => {
    let s = selectRange(selectOne(emptySelection(), "a"), order, "c");
    expect(pruneSelection(s, order)).toBe(s);
    s = pruneSelection(s, ["b", "c", "x"]);
    expect(sel(s)).toEqual(["b", "c"]);
    expect(s.anchor).toBeNull();
    expect(s.focus).toBe("c");
    expect(selectedPaths(s, ["c", "b"])).toEqual(["c", "b"]);
  });
});

describe("history", () => {
  it("pushes, goes back and forward, drops forward on push", () => {
    let h = createHistory("/a");
    expect(canBack(h)).toBe(false);
    h = historyPush(h, "/b");
    h = historyPush(h, "/c");
    expect(historyCurrent(h)).toBe("/c");
    h = historyBack(h);
    h = historyBack(h);
    expect(historyCurrent(h)).toBe("/a");
    expect(canBack(h)).toBe(false);
    expect(canForward(h)).toBe(true);
    expect(historyBack(h)).toBe(h);
    h = historyForward(h);
    expect(historyCurrent(h)).toBe("/b");
    h = historyPush(h, "/d");
    expect(canForward(h)).toBe(false);
    expect(h.stack).toEqual(["/a", "/b", "/d"]);
  });
  it("same path twice is a no-op", () => {
    const h = createHistory("/a");
    expect(historyPush(h, "/a")).toBe(h);
    expect(historyForward(h)).toBe(h);
  });
});

describe("clipboard", () => {
  const clip = (mode: "copy" | "cut", paths = ["/a/x"]) => ({ mode, machineId: "m1", paths });
  it("maps modes to ops", () => {
    expect(pasteDecision(clip("copy"), "m1", "/b")).toEqual({ ok: true, op: "copy" });
    expect(pasteDecision(clip("cut"), "m1", "/b")).toEqual({ ok: true, op: "move" });
  });
  it("rejects empty, cross-machine, same-dir cut and into-self", () => {
    expect(pasteDecision(null, "m1", "/b").ok).toBe(false);
    expect(pasteDecision(clip("copy", []), "m1", "/b").ok).toBe(false);
    expect(pasteDecision(clip("copy"), "m2", "/b").ok).toBe(false);
    expect(pasteDecision(clip("cut"), "m1", "/a").ok).toBe(false);
    expect(pasteDecision(clip("copy"), "m1", "/a")).toEqual({ ok: true, op: "copy" });
    expect(pasteDecision(clip("copy"), "m1", "/a/x/sub").ok).toBe(false);
    expect(pasteDecision(clip("cut"), "m1", "/a/x").ok).toBe(false);
    expect(pasteDecision(clip("cut", ["/a/x"]), "m1", "/a/xy")).toEqual({ ok: true, op: "move" });
  });
  it("clears cut after paste, keeps copy", () => {
    expect(clipboardAfterPaste(clip("cut"))).toBeNull();
    expect(clipboardAfterPaste(clip("copy"))).toEqual(clip("copy"));
  });
});

describe("prefs storage", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  it("round-trips pinned folders and view prefs (memory fallback without storage)", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(pinnedFolders("p1")).toEqual([]);
    expect(pinFolder("p1", "/a")).toEqual(["/a"]);
    expect(pinFolder("p1", "/a")).toEqual(["/a"]);
    expect(pinFolder("p1", "/b")).toEqual(["/a", "/b"]);
    expect(pinnedFolders("p1")).toEqual(["/a", "/b"]);
    expect(pinnedFolders("p2")).toEqual([]);
    expect(unpinFolder("p1", "/a")).toEqual(["/b"]);
    expect(viewPrefs("p1")).toEqual({ view: "list", sort: { key: "name", dir: "asc" } });
    setViewPrefs("p1", { view: "icons", sort: { key: "size", dir: "desc" } });
    expect(viewPrefs("p1")).toEqual({ view: "icons", sort: { key: "size", dir: "desc" } });
  });
  it("survives a throwing localStorage", () => {
    const boom = () => {
      throw new Error("denied");
    };
    vi.stubGlobal("localStorage", { getItem: boom, setItem: boom, removeItem: boom });
    expect(pinnedFolders("t1")).toEqual([]);
    expect(pinFolder("t1", "/z")).toEqual(["/z"]);
    expect(pinnedFolders("t1")).toEqual(["/z"]);
    expect(viewPrefs("t1").view).toBe("list");
  });
  it("uses localStorage when present and ignores corrupt data", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    pinFolder("s1", "/q");
    expect([...store.values()].some((v) => v.includes("/q"))).toBe(true);
    for (const k of store.keys()) store.set(k, "{nope");
    expect(pinnedFolders("s1")).toEqual([]);
    store.set("offdesk.files.view.s1", JSON.stringify({ view: "x", sort: { key: "bad", dir: "up" } }));
    expect(viewPrefs("s1")).toEqual({ view: "list", sort: { key: "name", dir: "asc" } });
  });
});

describe("describeFsOpError", () => {
  const err = (code: string, path?: string, message = "m") =>
    new RemoteFileError(409, code, message, undefined, path);
  it("maps codes", () => {
    expect(describeFsOpError(err("exists", "/a/foo.txt"))).toBe("An item named “foo.txt” already exists");
    expect(describeFsOpError(err("exists"), "bar")).toBe("An item named “bar” already exists");
    expect(describeFsOpError(err("machine_outdated"))).toBe("Update this machine to manage files");
    expect(describeFsOpError(err("no_space"))).toBe("Not enough free space on the machine");
    expect(describeFsOpError(err("permission_denied", "/a/b"))).toBe("No permission to change b");
    expect(describeFsOpError(err("invalid", undefined, "Name cannot contain /"))).toBe("Name cannot contain /");
    expect(describeFsOpError(err("not_found", "/a/b"))).toBe("b no longer exists");
    expect(describeFsOpError(err("timeout"))).toBe("The machine is offline or not responding");
  });
  it("tells an old hub (bare 404) from a missing item", () => {
    expect(describeFsOpError(new RemoteFileError(404, "hub_outdated", "404: "))).toBe(
      "Update the hub to manage files",
    );
    expect(describeFsOpError(new RemoteFileError(404, "not_found", "m", undefined, "/a/b"))).toBe(
      "b no longer exists",
    );
  });
  it("keeps the node's too_large message", () => {
    expect(describeFsOpError(err("too_large", undefined, "The zip would be over 256 MB"))).toBe(
      "The zip would be over 256 MB",
    );
  });
  it("falls back for plain errors", () => {
    expect(describeFsOpError(new Error("Failed to fetch"))).toBe("The machine is offline or not responding");
    expect(describeFsOpError(new Error("boom"))).toBe("boom");
    expect(describeFsOpError(err("io", undefined, "disk on fire"))).toBe("disk on fire");
  });
});

const fileOf = (bytes: number[], name = "f.bin") => {
  const blob = new Blob([new Uint8Array(bytes)]) as Blob & { name?: string };
  blob.name = name;
  return blob;
};
const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));

function fakeUploadApi() {
  const calls: string[] = [];
  const chunks: string[] = [];
  const api: UploadApi = {
    uploadBegin: vi.fn(async () => {
      calls.push("begin");
      return { upload_id: "u1" };
    }),
    uploadChunk: vi.fn(async (_m, _id, index, data) => {
      calls.push(`chunk${index}`);
      chunks.push(data);
      return { received: 0 };
    }),
    uploadEnd: vi.fn(async () => {
      calls.push("end");
      return { path: "/d/f.bin", size: 5 };
    }),
    uploadAbort: vi.fn(async () => {
      calls.push("abort");
    }),
  };
  return { api, calls, chunks };
}

describe("uploadToDirectory", () => {
  it("slices into chunks and reports progress", async () => {
    const { api, calls, chunks } = fakeUploadApi();
    const progress: Array<[number, number]> = [];
    const res = await uploadToDirectory({
      machineId: "m",
      destDir: "/d",
      file: fileOf([1, 2, 3, 4, 5]),
      onConflict: "keep_both",
      onProgress: (a, b) => progress.push([a, b]),
      api,
      chunkBytes: 2,
    });
    expect(res).toEqual({ path: "/d/f.bin", size: 5 });
    expect(calls).toEqual(["begin", "chunk0", "chunk1", "chunk2", "end"]);
    expect(chunks).toEqual([b64([1, 2]), b64([3, 4]), b64([5])]);
    expect(progress.at(-1)).toEqual([5, 5]);
    expect(api.uploadBegin).toHaveBeenCalledWith(
      "m",
      { dest_dir: "/d", filename: "f.bin", size: 5, on_conflict: "keep_both" },
      undefined,
    );
  });
  it("handles an empty file", async () => {
    const { api, calls } = fakeUploadApi();
    await uploadToDirectory({ machineId: "m", destDir: "/d", file: fileOf([]), onConflict: "error", api });
    expect(calls).toEqual(["begin", "end"]);
  });
  it("aborts on a chunk error and rethrows", async () => {
    const { api, calls } = fakeUploadApi();
    api.uploadChunk = vi.fn(async (_m, _id, index) => {
      if (index === 1) throw new RemoteFileError(507, "no_space", "full");
      return {};
    });
    await expect(
      uploadToDirectory({ machineId: "m", destDir: "/d", file: fileOf([1, 2, 3]), onConflict: "error", api, chunkBytes: 1 }),
    ).rejects.toMatchObject({ code: "no_space" });
    expect(calls).toEqual(["begin", "abort"]);
  });
  it("aborts when the signal fires mid-upload; swallows uploadAbort failure", async () => {
    const { api, calls } = fakeUploadApi();
    const ctrl = new AbortController();
    api.uploadChunk = vi.fn(async () => {
      ctrl.abort();
      return {};
    });
    api.uploadAbort = vi.fn(async () => {
      calls.push("abort");
      throw new Error("gone");
    });
    await expect(
      uploadToDirectory({ machineId: "m", destDir: "/d", file: fileOf([1, 2, 3]), onConflict: "error", api, chunkBytes: 1, signal: ctrl.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toEqual(["begin", "abort"]);
  });
  it("does not begin when already aborted", async () => {
    const { api } = fakeUploadApi();
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      uploadToDirectory({ machineId: "m", destDir: "/d", file: fileOf([1]), onConflict: "error", api, signal: ctrl.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(api.uploadBegin).not.toHaveBeenCalled();
  });
});

describe("downloadRemote / downloadZip", () => {
  const data = [1, 2, 3, 4, 5];
  const readRange = vi.fn(async (_m: string, _p: string, offset: number, length: number) => {
    const part = data.slice(offset, offset + length);
    return { size: data.length, data_base64: b64(part), eof: offset + length >= data.length };
  });
  beforeEach(() => readRange.mockClear());

  it("assembles ranges into a blob", async () => {
    const progress: number[] = [];
    const blob = await downloadRemote({
      machineId: "m", path: "/f", size: 5, api: { readRange }, chunkBytes: 2,
      onProgress: (n) => progress.push(n),
    });
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array(data));
    expect(readRange.mock.calls.map((c) => c[2])).toEqual([0, 2, 4]);
    expect(progress).toEqual([2, 4, 5]);
  });
  it("reads an empty file with one call", async () => {
    const empty = vi.fn(async () => ({ size: 0, data_base64: "", eof: true }));
    const blob = await downloadRemote({ machineId: "m", path: "/f", size: 0, api: { readRange: empty } });
    expect(blob.size).toBe(0);
    expect(empty).toHaveBeenCalledTimes(1);
  });
  it("fails instead of looping on an empty non-final chunk", async () => {
    const stuck = vi.fn(async () => ({ size: 10, data_base64: "", eof: false }));
    await expect(
      downloadRemote({ machineId: "m", path: "/f", size: 10, api: { readRange: stuck } }),
    ).rejects.toThrow();
  });
  it("stops on abort", async () => {
    const ctrl = new AbortController();
    const api = {
      readRange: vi.fn(async () => {
        ctrl.abort();
        return { size: 10, data_base64: b64([1]), eof: false };
      }),
    };
    await expect(
      downloadRemote({ machineId: "m", path: "/f", size: 10, api, signal: ctrl.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(api.readRange).toHaveBeenCalledTimes(1);
  });
  it("refuses files over the cap before reading", async () => {
    const api = { readRange: vi.fn() };
    await expect(
      downloadRemote({ machineId: "m", path: "/f", size: MAX_DOWNLOAD_BYTES + 1, api }),
    ).rejects.toMatchObject({
      code: "too_large",
      message: "Files over 256 MB can't be downloaded here yet",
    });
    expect(api.readRange).not.toHaveBeenCalled();
  });
  it("refuses when the file grows past the cap while reading", async () => {
    const grown = vi.fn(async () => ({ size: MAX_DOWNLOAD_BYTES + 1, data_base64: b64([1]), eof: false }));
    await expect(
      downloadRemote({ machineId: "m", path: "/f", size: 1, api: { readRange: grown } }),
    ).rejects.toMatchObject({ code: "too_large" });
  });
  it("zip: refuses an oversized zip without pulling it", async () => {
    const zipPaths = vi.fn(async () => ({ path: "/tmp/z.zip", size: MAX_DOWNLOAD_BYTES + 1, name: "s" }));
    const api = { readRange: vi.fn(), zipPaths };
    await expect(downloadZip({ machineId: "m", paths: ["/a"], api })).rejects.toMatchObject({
      code: "too_large",
    });
    expect(api.readRange).not.toHaveBeenCalled();
  });
  it("zip: asks the node to zip, then pulls the result", async () => {
    const zipPaths = vi.fn(async () => ({ path: "/tmp/z.zip", size: 5, name: "stuff" }));
    const res = await downloadZip({ machineId: "m", paths: ["/a", "/b"], api: { readRange, zipPaths } });
    expect(zipPaths).toHaveBeenCalledWith("m", ["/a", "/b"], undefined);
    expect(readRange.mock.calls[0][1]).toBe("/tmp/z.zip");
    expect(res.filename).toBe("stuff.zip");
    expect(res.blob.size).toBe(5);
  });
});

describe("blobToBase64", () => {
  it("matches a single-shot encoding across slice boundaries", async () => {
    const bytes = Array.from({ length: 3 * 256 * 1024 + 7 }, (_, i) => i % 251);
    const blob = new Blob([new Uint8Array(bytes)]);
    let expected = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      expected += String.fromCharCode(...bytes.slice(i, i + 0x8000));
    }
    expect(await blobToBase64(blob)).toBe(btoa(expected));
  });
});
