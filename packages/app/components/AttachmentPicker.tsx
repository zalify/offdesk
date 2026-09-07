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
