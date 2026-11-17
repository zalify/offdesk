import { describe, expect, it } from "vitest";
import type { DirEntry } from "@offdesk/shared";
import {
  actionTargets,
  buildMenu,
  dropDecision,
  freeDefaultName,
  pasteTarget,
  renameSelectionEnd,
  selectionOf,
  splitExtension,
  terminalDirFor,
  touchesDirtyFile,
  trashedNotice,
} from "./fileActions";
import type { MenuContext, MenuSpec } from "./fileActions";

const file = (name: string, dir = "/h"): DirEntry => ({ name, path: `${dir}/${name}`, is_dir: false, size: 10 });
const folder = (name: string, dir = "/h"): DirEntry => ({ name, path: `${dir}/${name}`, is_dir: true });

const ids = (specs: MenuSpec[]) => specs.map((s) => (s === "separator" ? "-" : s.id));
const ctx = (over: Partial<MenuContext> = {}): MenuContext => ({
  targets: [],
  canEdit: true,
  machineId: "m1",
  currentDir: "/h",
  clipboard: null,
  canOpenTerminal: true,
  showHidden: false,
  pinned: [],
  ...over,
});

describe("default names", () => {
  it("finds a free folder name", () => {
    expect(freeDefaultName("folder", [])).toBe("untitled folder");
    expect(freeDefaultName("folder", ["untitled folder"])).toBe("untitled folder 2");
    expect(freeDefaultName("folder", ["untitled folder", "Untitled Folder 2"])).toBe("untitled folder 3");
  });
  it("finds a free file name keeping the extension last", () => {
    expect(freeDefaultName("file", ["a"])).toBe("untitled.txt");
    expect(freeDefaultName("file", ["untitled.txt", "untitled 2.txt"])).toBe("untitled 3.txt");
  });
});

describe("rename selection", () => {
  it("selects the stem of files only", () => {
    expect(splitExtension("a.tar.gz", false)).toEqual(["a.tar", ".gz"]);
    expect(splitExtension(".env", false)).toEqual([".env", ""]);
    expect(splitExtension("v1.2", true)).toEqual(["v1.2", ""]);
    expect(renameSelectionEnd("notes.md", false)).toBe(5);
    expect(renameSelectionEnd("notes.md", true)).toBe(8);
  });
});

describe("editor guard", () => {
  it("matches the file itself and folders that contain it", () => {
    expect(touchesDirtyFile(["/h/a.txt"], "/h/a.txt")).toBe(true);
    expect(touchesDirtyFile(["/h/dir"], "/h/dir/a.txt")).toBe(true);
    expect(touchesDirtyFile(["/h/dir2"], "/h/dir/a.txt")).toBe(false);
    expect(touchesDirtyFile(["/h/a.txt"], null)).toBe(false);
  });
});

describe("drop decisions", () => {
  const drag = { machineId: "m1", paths: ["/h/a", "/h/b"] };
  it("moves into another folder, copies with alt", () => {
    expect(dropDecision(drag, "m1", "/h/dest", false)).toEqual({ ok: true, op: "move" });
    expect(dropDecision(drag, "m1", "/h/dest", true)).toEqual({ ok: true, op: "copy" });
  });
  it("refuses itself, descendants, the same folder and other machines", () => {
    expect(dropDecision(drag, "m1", "/h/a", false).ok).toBe(false);
    expect(dropDecision(drag, "m1", "/h/a/sub", false).ok).toBe(false);
    expect(dropDecision(drag, "m1", "/h", false).ok).toBe(false);
    expect(dropDecision(drag, "m2", "/h/dest", false).ok).toBe(false);
  });
});

describe("targets and selection", () => {
  it("uses the selection when the clicked item is in it, else the item", () => {
    const a = file("a");
    const b = file("b");
    expect(actionTargets(a, [a, b])).toEqual([a, b]);
    expect(actionTargets(file("c"), [a, b]).map((e) => e.name)).toEqual(["c"]);
    expect(actionTargets(null, [a])).toEqual([a]);
  });
  it("selectionOf focuses the last path", () => {
    const s = selectionOf(["/a", "/b"]);
    expect([...s.selected]).toEqual(["/a", "/b"]);
    expect(s.focus).toBe("/b");
    expect(selectionOf([]).focus).toBeNull();
  });
});

describe("context menu", () => {
  it("lists the empty-area actions", () => {
    expect(ids(buildMenu(ctx()))).toEqual([
      "new-folder", "new-file", "upload", "-", "open-terminal", "refresh", "show-hidden",
    ]);
  });
  it("offers paste on the empty area only with a clipboard", () => {
    const clipboard = { mode: "copy" as const, machineId: "m1", paths: ["/x/a"] };
    const paste = buildMenu(ctx({ clipboard })).find((s) => s !== "separator" && s.id === "paste");
    expect(paste).toMatchObject({ disabled: false });
    const other = buildMenu(ctx({ clipboard: { ...clipboard, machineId: "m2" } })).find(
      (s) => s !== "separator" && s.id === "paste",
    );
    expect(other).toMatchObject({ disabled: true });
  });
  it("builds the single-file menu", () => {
    expect(ids(buildMenu(ctx({ targets: [file("a.txt")] })))).toEqual([
      "open", "quicklook", "-", "rename", "duplicate", "copy", "cut", "-", "trash", "-",
      "download", "copy-path", "open-terminal",
    ]);
  });
  it("builds the folder menu with paste-into and pin", () => {
    const clipboard = { mode: "cut" as const, machineId: "m1", paths: ["/x/a"] };
    const specs = buildMenu(ctx({ targets: [folder("d")], clipboard }));
    expect(ids(specs)).toContain("pin");
    expect(ids(specs)).not.toContain("quicklook");
    expect(specs.find((s) => s !== "separator" && s.id === "paste")).toMatchObject({
      label: "Paste into “d”",
      disabled: false,
    });
    expect(specs.find((s) => s !== "separator" && s.id === "download")).toMatchObject({
      label: "Download as Zip",
    });
  });
  it("drops single-item actions for a multi-selection", () => {
    const list = ids(buildMenu(ctx({ targets: [file("a"), file("b")] })));
    expect(list).not.toContain("open");
    expect(list).not.toContain("rename");
    expect(list).not.toContain("open-terminal");
    expect(list).toContain("trash");
  });
  it("hides every mutating action when not editable", () => {
    const item = ids(buildMenu(ctx({ targets: [file("a")], canEdit: false })));
    expect(item).toEqual(["open", "quicklook", "-", "download", "copy-path", "open-terminal"]);
    const empty = ids(buildMenu(ctx({ canEdit: false })));
    expect(empty).toEqual(["open-terminal", "refresh", "show-hidden"]);
  });
  it("omits Open in Terminal when unavailable", () => {
    expect(ids(buildMenu(ctx({ targets: [file("a")], canOpenTerminal: false })))).not.toContain("open-terminal");
  });
});

describe("helpers", () => {
  it("pastes into a single selected folder, else the current folder", () => {
    expect(pasteTarget([folder("d")], "/h")).toBe("/h/d");
    expect(pasteTarget([file("f")], "/h")).toBe("/h");
    expect(pasteTarget([], "/h")).toBe("/h");
  });
  it("opens a terminal in the folder or the file's directory", () => {
    expect(terminalDirFor([folder("d")], "/h")).toBe("/h/d");
    expect(terminalDirFor([file("f", "/h/x")], "/h")).toBe("/h/x");
    expect(terminalDirFor([], "/h")).toBe("/h");
  });
  it("words the trash notice", () => {
    expect(trashedNotice([file("a")])).toBe("Moved 1 item to Trash");
    expect(trashedNotice([file("a"), file("b")])).toBe("Moved 2 items to Trash");
  });
});
