import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { colors } from "@/lib/colors";

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
  const style = { minHeight: 44, border: `1px solid ${colors.border}`, borderRadius: 8, padding: "10px 16px", background: colors.background, color: colors.foreground, font: "inherit", cursor: "pointer" };
  return createPortal(<dialog ref={dialog} aria-label="Add attachment" onCancel={onClose}
    style={{ color: colors.foreground, background: colors.surface, border: `1px solid ${colors.border}`, borderRadius: 14, width: "min(320px, calc(100vw - 40px))", boxSizing: "border-box", padding: 16 }}>
    <p style={{ margin: "0 0 12px", fontWeight: 600 }}>Add attachment</p>
    <div style={{ display: "grid", gap: 8 }}>
      <button style={style} onClick={() => { onPhotos(); onClose(); }}>Choose photos</button>
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
  const button = { minHeight: 44, border: `1px solid ${colors.border}`, borderRadius: 8, padding: "8px 12px", background: colors.background, color: colors.foreground, font: "inherit", cursor: "pointer" };
  return createPortal(<dialog ref={dialog} aria-label="Review attachments"
    onCancel={event => { event.preventDefault(); if (!uploading) onCancel(); }}
    style={{ color: colors.foreground, background: colors.surface, border: `1px solid ${colors.border}`, borderRadius: 14, width: "min(420px, calc(100vw - 32px))", maxHeight: "80dvh", boxSizing: "border-box", padding: 16 }}>
    <p style={{ margin: "0 0 12px", fontWeight: 600 }}>Attachments · {files.length}</p>
    <ul style={{ listStyle: "none", margin: 0, padding: 0, maxHeight: "40dvh", overflowY: "auto" }}>
      {files.map((file, index) => <li key={index} style={{ display: "flex", alignItems: "center", gap: 8, paddingBlock: 4 }}>
        <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{file.name}
          <small style={{ display: "block", color: colors.fg2 }}>{formatAttachmentSize(file.size)}</small>
        </span>
        <button type="button" style={button} disabled={uploading} aria-label={`Remove ${file.name}`} onClick={() => onRemove(index)}>Remove</button>
      </li>)}
    </ul>
    {error && <p role="alert">{error}</p>}
    {!canSend && <p role="status">Take control to send these attachments.</p>}
    <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
      <button type="button" style={button} disabled={uploading} onClick={onCancel}>Cancel</button>
      <button type="button" style={{ ...button, background: colors.accent, color: colors.onAccent }} disabled={uploading || !canSend || !files.length} onClick={onSend}>
        {uploading ? "Sending…" : `Send ${files.length === 1 ? "attachment" : "attachments"}`}
      </button>
    </div>
  </dialog>, document.body);
}
