import { useEffect, useRef, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { colors } from "@/lib/colors";
import { MAX_IMAGE_PASTE_BYTES } from "@/lib/terminalImagePaste";
import { rem } from "@/lib/rem";

/** Keep photo-library and document-provider choices explicit on phones. */
export function AttachmentPicker({ onPhotos, onFiles, onClose }: {
  onPhotos: () => void; onFiles: () => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => { element?.close(); };
  }, []);
  const style = { minHeight: 44, border: `1px solid ${colors.line}`, borderRadius: 4, padding: "10px 16px", background: "transparent", color: colors.fg0, font: "inherit", fontFamily: "var(--font-display)", fontSize: rem(13), textTransform: "lowercase" as const, cursor: "pointer" };
  return createPortal(<dialog ref={dialog} aria-label="Add attachment" onCancel={onClose}
    style={{ color: colors.fg0, background: colors.bg2, border: `1px solid ${colors.line}`, borderRadius: 6, width: "min(320px, calc(100vw - 40px))", boxSizing: "border-box", padding: 16, fontFamily: "var(--font-display)" }}>
    <p style={{ margin: "0 0 12px", fontSize: rem(15), fontWeight: 600 }}>Add attachment</p>
    <div style={{ display: "grid", gap: 8 }}>
      <button style={style} onClick={() => { onPhotos(); onClose(); }}>Choose photos or videos</button>
      <button style={style} onClick={() => { onFiles(); onClose(); }}>Choose files</button>
      <button style={style} onClick={onClose}>Cancel</button>
    </div>
  </dialog>, document.body);
}

export function formatAttachmentSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Review stays scoped to this terminal, and never sends on selection alone. */
export function AttachmentReview({ files, uploading, error, canSend, onSend, onRemove, onCancel }: {
  files: File[]; uploading: boolean; error: string | null; canSend: boolean;
  onSend: () => void; onRemove: (index: number) => void; onCancel: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  // Screen recordings often pass the single-message limit; say so before
  // sending rather than failing partway through the batch.
  const maxLabel = formatAttachmentSize(MAX_IMAGE_PASTE_BYTES);
  const tooLarge = files.some(file => file.size > MAX_IMAGE_PASTE_BYTES);
  const button: CSSProperties = { minWidth: 0, maxWidth: "100%", overflowWrap: "anywhere", minHeight: 44, border: `1px solid ${colors.line}`, borderRadius: 4, padding: "8px 12px", background: "transparent", color: colors.fg0, font: "inherit", fontFamily: "var(--font-display)", fontSize: rem(13), textTransform: "lowercase", cursor: "pointer" };
  return createPortal(<dialog ref={dialog} aria-label="Review attachments"
    onCancel={event => { event.preventDefault(); if (!uploading) onCancel(); }}
    style={{ color: colors.fg0, background: colors.bg2, border: `1px solid ${colors.line}`, borderRadius: 6, width: "min(420px, calc(100vw - 32px))", maxHeight: "80dvh", overflow: "hidden", boxSizing: "border-box", padding: 16, fontFamily: "var(--font-display)" }}>
    <div style={{ display: "flex", flexDirection: "column", maxHeight: "calc(80dvh - 34px)" }}>
    <p style={{ margin: "0 0 12px", fontSize: rem(15), fontWeight: 600, flexShrink: 0 }}>Attachments · {files.length}</p>
    <ul style={{ listStyle: "none", margin: 0, padding: 4, maxHeight: "40dvh", minHeight: 0, flex: "0 1 auto", overflowY: "auto" }}>
      {files.map((file, index) => <li key={index} style={{ display: "flex", alignItems: "center", gap: 8, paddingBlock: 4 }}>
        <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{file.name}
          <small style={{ display: "block", color: file.size > MAX_IMAGE_PASTE_BYTES ? colors.err : colors.fg3 }}>
            {formatAttachmentSize(file.size)}{file.size > MAX_IMAGE_PASTE_BYTES && ` · over the ${maxLabel} limit`}
          </small>
        </span>
        <button type="button" style={{ ...button, flexShrink: 0 }} disabled={uploading} aria-label={`Remove ${file.name}`} onClick={() => onRemove(index)}>Remove</button>
      </li>)}
    </ul>
    {error && <p role="alert" style={{ minHeight: 0, overflowY: "auto" }}>{error}</p>}
    {tooLarge && <p role="alert">Remove files over {maxLabel} to send. Trim long recordings first.</p>}
    {!canSend && <p role="status">Take control to send these attachments.</p>}
    <div style={{ display: "flex", flexWrap: "wrap", flexShrink: 0, justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
      <button type="button" style={button} disabled={uploading} onClick={onCancel}>Cancel</button>
      <button type="button" style={{ ...button, border: "none", background: colors.primary, color: colors.onPrimary, fontWeight: 600 }} disabled={uploading || !canSend || !files.length || tooLarge} onClick={onSend}>
        {uploading ? "Sending…" : `Send ${files.length === 1 ? "attachment" : "attachments"}`}
      </button>
    </div>
    </div>
  </dialog>, document.body);
}
