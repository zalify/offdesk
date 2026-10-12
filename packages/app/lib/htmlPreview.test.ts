import { describe, expect, it, vi } from "vitest";
import type { DirEntry } from "@offdesk/shared";
import { RemoteFileError } from "./api";
import type { RemoteFile } from "./api";
import {
  answerPreviewRequest,
  fileResponse,
  isHtmlFile,
  previewMime,
  previewRoot,
  previewUrlPath,
  resolvePreviewRequest,
  rewriteFileUrls,
} from "./htmlPreview";

const bytesB64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const b64 = (text: string) => bytesB64(new TextEncoder().encode(text));
const text = (base64: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
const file = (name: string, body: string, mime = "application/octet-stream"): RemoteFile => ({
  name,
  path: `/p/${name}`,
  mime,
  size: body.length,
  data_base64: b64(body),
});
const entry = (name: string): DirEntry => ({ name, is_dir: true }) as DirEntry;

describe("isHtmlFile", () => {
  it("knows .html and .htm, any case", () => {
    expect(isHtmlFile("AppHeader-dark.html")).toBe(true);
    expect(isHtmlFile("INDEX.HTM")).toBe(true);
    expect(isHtmlFile("notes.md")).toBe(false);
    expect(isHtmlFile("html")).toBe(false);
  });
});

describe("rewriteFileUrls", () => {
  it("turns file URLs into absolute paths", () => {
    const html =
      '<link href="file:///Users/me/ds/tokens.css"><script src="react.js"></script>' +
      '<img src="FILE://localhost/Users/me/a b.png">';
    expect(rewriteFileUrls(html)).toBe(
      '<link href="/Users/me/ds/tokens.css"><script src="react.js"></script>' +
        '<img src="/Users/me/a b.png">',
    );
  });

  it("leaves other URLs and file:// without a path alone", () => {
    const html = 'https://cdn.example/x.js "file://" file://host/share';
    expect(rewriteFileUrls(html)).toBe(html);
  });
});

describe("previewUrlPath", () => {
  it("encodes each segment and keeps the slashes", () => {
    expect(previewUrlPath("/Users/me/设计 稿/a#1.html")).toBe(
      "/Users/me/%E8%AE%BE%E8%AE%A1%20%E7%A8%BF/a%231.html",
    );
  });
});

describe("previewMime", () => {
  it("goes by the extension first", () => {
    expect(previewMime("bundle.js", "text/plain")).toBe("text/javascript");
    expect(previewMime("a.mjs", "")).toBe("text/javascript");
    expect(previewMime("font.woff2", "application/octet-stream")).toBe("font/woff2");
    expect(previewMime("data.bin", "application/x-thing")).toBe("application/x-thing");
    expect(previewMime("data", "")).toBe("application/octet-stream");
  });
});

describe("previewRoot", () => {
  it("is the git checkout around the file", async () => {
    const list = vi.fn(async (dir: string) =>
      dir === "/Users/me/todo" ? [entry("src"), entry(".git")] : [entry("x")],
    );
    await expect(previewRoot("/Users/me/todo/output/ds/test/a.html", list)).resolves.toBe(
      "/Users/me/todo",
    );
    expect(list.mock.calls.map(([dir]) => dir)).toEqual([
      "/Users/me/todo/output/ds/test",
      "/Users/me/todo/output/ds",
      "/Users/me/todo/output",
      "/Users/me/todo",
    ]);
  });

  it("falls back to the file's folder, never climbing to /", async () => {
    const list = vi.fn(async (_dir: string) => [entry("x")]);
    await expect(previewRoot("/tmp/site/index.html", list)).resolves.toBe("/tmp/site");
    expect(list.mock.calls.map(([dir]) => dir)).toEqual(["/tmp/site", "/tmp"]);
  });

  it("stops at a folder it cannot list", async () => {
    const list = vi.fn(async (dir: string) => {
      if (dir === "/a/b") throw new Error("denied");
      return [entry("x")];
    });
    await expect(previewRoot("/a/b/c/index.html", list)).resolves.toBe("/a/b/c");
  });
});

describe("resolvePreviewRequest", () => {
  const root = "/Users/me/todo";

  it("serves files under the root", () => {
    expect(resolvePreviewRequest(root, "/Users/me/todo/ds/tokens.css")).toEqual({
      path: "/Users/me/todo/ds/tokens.css",
    });
    expect(resolvePreviewRequest(root, "/Users/me/todo/site/")).toEqual({
      path: "/Users/me/todo/site/index.html",
    });
  });

  it("refuses paths outside the root, even with a shared prefix", () => {
    expect(resolvePreviewRequest(root, "/Users/me/todo-secrets/a.txt")).toMatchObject({ status: 403 });
    expect(resolvePreviewRequest(root, "/Users/me/.ssh/id_ed25519")).toMatchObject({ status: 403 });
    expect(resolvePreviewRequest(root, "/etc/hosts")).toMatchObject({ status: 403 });
  });

  it("refuses hidden files and dot segments", () => {
    expect(resolvePreviewRequest(root, "/Users/me/todo/.env")).toMatchObject({ status: 403 });
    expect(resolvePreviewRequest(root, "/Users/me/todo/.git/config")).toMatchObject({ status: 403 });
    expect(resolvePreviewRequest(root, "/Users/me/todo/../x")).toMatchObject({ status: 400 });
    expect(resolvePreviewRequest(root, "relative.css")).toMatchObject({ status: 400 });
  });
});

describe("fileResponse", () => {
  it("rewrites file URLs in HTML, CSS and scripts and labels them UTF-8", () => {
    const res = fileResponse(file("a.html", '<link href="file:///Users/me/t.css">', "text/html"));
    expect(res.status).toBe(200);
    expect(res.mime).toBe("text/html; charset=utf-8");
    expect(text(res.dataBase64)).toBe('<link href="/Users/me/t.css">');

    const css = fileResponse(file("t.css", "a{background:url(file:///Users/me/bg.png)}"));
    expect(css.mime).toBe("text/css; charset=utf-8");
    expect(text(css.dataBase64)).toBe("a{background:url(/Users/me/bg.png)}");
  });

  it("passes other files through untouched", () => {
    const png = file("a.png", "file:///not-text");
    expect(fileResponse(png)).toEqual({ status: 200, mime: "image/png", dataBase64: png.data_base64 });
  });

  it("does not rewrite text that is not UTF-8", () => {
    const gbk: RemoteFile = { ...file("a.html", ""), data_base64: bytesB64(new Uint8Array([0xc4, 0xe3, 0xba, 0xc3])) };
    expect(fileResponse(gbk)).toEqual({ status: 200, mime: "text/html", dataBase64: gbk.data_base64 });
  });
});

describe("answerPreviewRequest", () => {
  it("reads allowed paths from the machine", async () => {
    const read = vi.fn(async (path: string) => file(path.split("/").pop()!, "body{}"));
    const res = await answerPreviewRequest("/r", "/r/a.css", read);
    expect(read).toHaveBeenCalledWith("/r/a.css");
    expect(res).toMatchObject({ status: 200, mime: "text/css; charset=utf-8" });
  });

  it("never reads refused paths", async () => {
    const read = vi.fn();
    const res = await answerPreviewRequest("/r", "/etc/passwd", read);
    expect(read).not.toHaveBeenCalled();
    expect(res.status).toBe(403);
  });

  it("maps read errors to HTTP statuses", async () => {
    const fail = (code: string) => async () => {
      throw new RemoteFileError(404, code, code);
    };
    expect((await answerPreviewRequest("/r", "/r/a", fail("not_found"))).status).toBe(404);
    expect((await answerPreviewRequest("/r", "/r/a", fail("too_large"))).status).toBe(413);
    expect((await answerPreviewRequest("/r", "/r/a", fail("machine_disconnected"))).status).toBe(502);
  });
});
