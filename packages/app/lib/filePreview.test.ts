import { describe, expect, it } from "vitest";
import {
  FALLBACK_PREVIEW_THEME,
  PREVIEW_CSP,
  analyzeFile,
  base64ToBytes,
  buildPreviewDocument,
  extensionOf,
  truncateText,
} from "./filePreview";

const enc = (s: string) => new TextEncoder().encode(s);
const OCTET = "application/octet-stream";

describe("analyzeFile", () => {
  it("detects images by extension even with an octet-stream mime", () => {
    expect(analyzeFile({ name: "a.PNG", mime: OCTET, bytes: new Uint8Array([0, 1]) })).toEqual({
      kind: "image",
      mime: "image/png",
    });
    expect(analyzeFile({ name: "a.svg", mime: "text/plain", bytes: enc("<svg/>") })).toEqual({
      kind: "image",
      mime: "image/svg+xml",
    });
  });

  it("falls back to an image mime for unknown extensions", () => {
    expect(analyzeFile({ name: "pic", mime: "image/heic", bytes: new Uint8Array([0]) }).kind).toBe("image");
  });

  it("detects markdown, docx and pdf", () => {
    expect(analyzeFile({ name: "n.md", mime: OCTET, bytes: enc("# 标题") })).toEqual({
      kind: "markdown",
      text: "# 标题",
    });
    expect(analyzeFile({ name: "合同.docx", mime: OCTET, bytes: new Uint8Array([0x50, 0x4b, 0, 0]) }).kind).toBe("docx");
    expect(analyzeFile({ name: "x", mime: "application/pdf", bytes: enc("%PDF") }).kind).toBe("pdf");
  });

  it("treats known code extensions and text mimes as text", () => {
    expect(analyzeFile({ name: "a.js", mime: OCTET, bytes: enc("let x = 1;") })).toEqual({
      kind: "text",
      text: "let x = 1;",
    });
    expect(analyzeFile({ name: "Dockerfile", mime: OCTET, bytes: enc("FROM x") }).kind).toBe("text");
    expect(analyzeFile({ name: "q", mime: "application/json", bytes: enc("{}") }).kind).toBe("text");
    expect(analyzeFile({ name: "page.html", mime: "text/html", bytes: enc("<h1>x</h1>") })).toEqual({
      kind: "text",
      text: "<h1>x</h1>",
    });
  });

  it("strips a UTF-8 BOM", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...enc("hi")]);
    expect(analyzeFile({ name: "a.txt", mime: "text/plain", bytes })).toEqual({ kind: "text", text: "hi" });
  });

  it("sniffs unknown files as UTF-8 text", () => {
    expect(analyzeFile({ name: "notes", mime: OCTET, bytes: enc("你好，世界") })).toEqual({
      kind: "text",
      text: "你好，世界",
    });
  });

  it("sniffs GB18030 Chinese text", () => {
    // "合同" in GBK/GB18030
    const bytes = new Uint8Array([0xba, 0xcf, 0xcd, 0xac]);
    expect(analyzeFile({ name: "合同", mime: OCTET, bytes })).toEqual({ kind: "text", text: "合同" });
    expect(analyzeFile({ name: "合同.txt", mime: "text/plain", bytes })).toEqual({ kind: "text", text: "合同" });
  });

  it("rejects binary content", () => {
    expect(analyzeFile({ name: "blob", mime: OCTET, bytes: new Uint8Array([1, 2, 0, 3]) }).kind).toBe("unsupported");
    expect(analyzeFile({ name: "a.txt", mime: "text/plain", bytes: new Uint8Array([65, 0, 66]) }).kind).toBe("unsupported");
    // invalid in both UTF-8 and GB18030
    expect(analyzeFile({ name: "blob", mime: OCTET, bytes: new Uint8Array([0xff, 0xfe, 0xff, 0xff]) }).kind).toBe("unsupported");
  });
});

describe("helpers", () => {
  it("extensionOf", () => {
    expect(extensionOf("a/b/c.TAR.gz")).toBe("gz");
    expect(extensionOf(".bashrc")).toBe("");
    expect(extensionOf("Makefile")).toBe("");
  });

  it("base64ToBytes", () => {
    expect(Array.from(base64ToBytes("YWJj"))).toEqual([97, 98, 99]);
  });

  it("truncateText keeps short text and cuts long text on a code point", () => {
    expect(truncateText("abc", 10)).toEqual({ text: "abc", truncated: false });
    expect(truncateText("abcdef", 3)).toEqual({ text: "abc", truncated: true });
    const cut = truncateText("a😀b", 2);
    expect(cut).toEqual({ text: "a", truncated: true });
  });
});

describe("buildPreviewDocument", () => {
  const doc = buildPreviewDocument("<p>hi</p><script>alert(1)</script>", FALLBACK_PREVIEW_THEME);

  it("starts with the CSP meta", () => {
    expect(doc.startsWith(`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`)).toBe(true);
    expect(PREVIEW_CSP).toBe(
      "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:",
    );
    expect(doc).toContain('<meta charset="utf-8">');
  });

  it("injects the theme and body", () => {
    expect(doc).toContain(FALLBACK_PREVIEW_THEME.fg);
    expect(doc).toContain("max-width: 860px");
    expect(doc).toContain("<p>hi</p>");
  });

  it("never grants script capabilities in the CSP", () => {
    expect(PREVIEW_CSP).not.toContain("script-src");
    expect(PREVIEW_CSP).not.toContain("unsafe-eval");
  });

  it("ignores theme values that could break out of the stylesheet", () => {
    const evil = buildPreviewDocument("", { ...FALLBACK_PREVIEW_THEME, fg: "red;}</style><script>x</script>" });
    expect(evil).not.toContain("<script>x");
  });
});
