// Pure helpers for editing a remote text file in the file browser: which
// files the plain editor can round-trip, and turning its text back into the
// file's bytes.

import { RemoteFileError } from "./api";
import { MAX_PREVIEW_TEXT_CHARS } from "./filePreview";

/** How the file wrote what the editor shows as plain `\n` text. */
export interface EditableText {
  text: string;
  /** The file started with a UTF-8 byte order mark. */
  bom: boolean;
  /** Its lines end in `\r\n`. */
  crlf: boolean;
}

/**
 * The file's text, if a textarea can edit it and save back the same bytes
 * where nothing changed: UTF-8 without NUL bytes, not longer than the preview
 * shows, and one kind of line ending (a textarea turns every `\r\n` and `\r`
 * into `\n`, so mixed endings could not be written back as they were).
 */
export function editableText(bytes: Uint8Array): EditableText | null {
  if (bytes.includes(0)) return null;
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
  const bom = decoded.charCodeAt(0) === 0xfeff;
  const body = bom ? decoded.slice(1) : decoded;
  if (body.length > MAX_PREVIEW_TEXT_CHARS) return null;
  const crlf = body.includes("\r\n");
  const bare = body.replace(/\r\n/g, "");
  if (bare.includes("\r") || (crlf && bare.includes("\n"))) return null;
  return { text: crlf ? body.replace(/\r\n/g, "\n") : body, bom, crlf };
}

/** The bytes to save for `text`, written the way the file was. */
export function encodeEditedText(text: string, { bom, crlf }: Pick<EditableText, "bom" | "crlf">): Uint8Array {
  const lines = text.replace(/\r\n/g, "\n");
  const body = crlf ? lines.replace(/\n/g, "\r\n") : lines;
  return new TextEncoder().encode(bom ? String.fromCharCode(0xfeff) + body : body);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** Shown when closing the file browser would lose an edit. */
export const UNSAVED_EDIT_NOTICE = "Save or cancel your edit first";

/** What went wrong saving `name`, for the editor's error line. */
export function describeSaveError(err: unknown, name: string): string {
  if (err instanceof RemoteFileError) {
    switch (err.code) {
      case "conflict":
        return `${name} changed on the machine since you opened it`;
      case "not_text":
        return `${name} is not plain UTF-8 text, so it can't be saved from here`;
      case "too_large":
        return `${name} is too large to save from here`;
      case "not_found":
        return `${name} is no longer there`;
      case "permission_denied":
        return `No permission to write ${name}`;
      case "machine_outdated":
        return "This machine's node is too old to save files. Update it first.";
      case "machine_not_found":
      case "machine_disconnected":
        return "The machine disconnected, so the file was not saved";
      case "timeout":
        return `Saving ${name} timed out; the machine did not respond`;
      default:
        return `Could not save ${name}: ${err.message}`;
    }
  }
  const message = err instanceof Error ? err.message : String(err);
  return `Could not save ${name}: ${message}`;
}
