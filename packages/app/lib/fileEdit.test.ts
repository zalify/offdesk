import { describe, expect, it } from "vitest";

import { RemoteFileError } from "./api";
import { base64ToBytes } from "./filePreview";
import { bytesToBase64, describeSaveError, editableText, encodeEditedText } from "./fileEdit";

const utf8 = (text: string) => new TextEncoder().encode(text);

describe("editableText", () => {
  it("round-trips a .env file unchanged", () => {
    const bytes = utf8("DATABASE_URL=postgres://x\nDEBUG=1\n");
    const file = editableText(bytes)!;
    expect(file).toEqual({ text: "DATABASE_URL=postgres://x\nDEBUG=1\n", bom: false, crlf: false });
    expect(encodeEditedText(file.text, file)).toEqual(bytes);
  });

  it("keeps CRLF line endings and the byte order mark", () => {
    const bytes = utf8("﻿a=1\r\nb=2\r\n");
    const file = editableText(bytes)!;
    expect(file).toMatchObject({ text: "a=1\nb=2\n", bom: true, crlf: true });
    expect(encodeEditedText(file.text, file)).toEqual(bytes);
    expect(encodeEditedText("a=1\nb=3\nc=4", file)).toEqual(utf8("﻿a=1\r\nb=3\r\nc=4"));
  });

  it("refuses what a textarea can't write back as it was", () => {
    expect(editableText(new Uint8Array([0x61, 0, 0x62]))).toBeNull();
    expect(editableText(new Uint8Array([0xc4, 0xe3]))).toBeNull(); // GB18030 你
    expect(editableText(utf8("a\r\nb\nc"))).toBeNull();
    expect(editableText(utf8("a\rb"))).toBeNull();
    expect(editableText(utf8("x".repeat(1_000_001)))).toBeNull();
    expect(editableText(utf8("中文 ok\n"))?.text).toBe("中文 ok\n");
  });
});

describe("bytesToBase64", () => {
  it("is the inverse of base64ToBytes, also past one chunk", () => {
    const bytes = utf8("é".repeat(40_000));
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });
});

describe("describeSaveError", () => {
  it("says the file changed on a conflict", () => {
    const err = new RemoteFileError(409, "conflict", "changed", undefined, undefined, "ab");
    expect(describeSaveError(err, ".env")).toBe(".env changed on the machine since you opened it");
  });

  it("tells an old machine apart from a conflict", () => {
    const err = new RemoteFileError(409, "machine_outdated", "old");
    expect(describeSaveError(err, ".env")).toMatch(/too old to save files/);
  });
});
