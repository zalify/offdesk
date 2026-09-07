import { AttachmentPicker, formatAttachmentSize } from "./AttachmentPicker";
import { useContext, useEffect, useRef, useState, type ReactNode, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Maximize2, Minimize2, X } from "lucide-react";
import { editComposerText } from "@/lib/editComposerText";
import { useAuth } from "@/lib/auth";
import { colors, colorAlpha } from "@/lib/colors";
import { getServerUrl } from "@/lib/serverUrl";
import { HubLatencyContext } from "@/lib/hubLatency";
import { readClipboardText } from "@/lib/readClipboardText";
import { newComposerId } from "@/lib/composerTransport";
import { loadComposerDraft, saveComposerDraft, loadComposerFile, saveComposerFile, removeComposerFile, type ComposerDraft } from "@/lib/composerDrafts";
import type { ComposerMessage, ComposerReceipt } from "@/lib/composerTransport";

const button: CSSProperties = { background: colors.surface, color: colors.foreground, border: `1px solid ${colors.border}`, borderRadius: 8, padding: "7px 10px", minHeight: 44, cursor: "pointer", fontFamily: "var(--font-display)", fontSize: ".875rem" };
const MAX_BYTES = 20 * 1024 * 1024;

function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(new Error("Could not read the image."));
    reader.readAsDataURL(file);
  });
}

export interface ComposerToolbarActions {
  onKey: (data: string) => void;
  onPaste: () => void;
  onInputSettings: () => void;
  onChooseAttachment?: () => void;
  onToggleKeyboard: () => void;
  local: boolean;
  enterLabel: string;
  enterDisabled: boolean;
}

export function LocalTerminalComposer({ machineId, terminalId, title, canSend, onModeChange, onDirectAction, onSend,
  renderToolbar, portalTarget, hidden = false, ctrlArmed, onToggleKeyboard, onKeyboardVisible }: {
  machineId: string; terminalId: string; title: string; canSend: boolean;
  onModeChange: (local: boolean) => void;
  onDirectAction: (data: string) => void;
  onSend: (message: ComposerMessage) => Promise<ComposerReceipt>;
  renderToolbar: (actions: ComposerToolbarActions) => ReactNode;
  portalTarget?: HTMLElement | null;
  hidden?: boolean;
  ctrlArmed: boolean;
  onToggleKeyboard: () => void;
  onKeyboardVisible: (visible: boolean) => void;
}) {
  const { user } = useAuth();
  const key = JSON.stringify([getServerUrl("web") || window.location.origin, user?.id, machineId, terminalId]);
  const [draft, setDraft] = useState<ComposerDraft | null>(null);
  const draftRef = useRef(draft);
  const [files, setFiles] = useState<{ id: string; file: File }[]>([]);
  const [saved, setSaved] = useState(true);
  const saveGeneration = useRef(0);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [suggestLocal, setSuggestLocal] = useState(false);
  const [suggestionDismissed, setSuggestionDismissed] = useState(false);
  const latency = useContext(HubLatencyContext);
  const input = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settings = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!settingsOpen) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Element;
      if (!settings.current?.contains(target) && !target.closest('[data-testid="terminal-input-settings"]')) setSettingsOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setSettingsOpen(false); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape, true); };
  }, [settingsOpen]);
  const fileInput = useRef<HTMLInputElement>(null);
  const documentInput = useRef<HTMLInputElement>(null);
  const [choosingAttachment, setChoosingAttachment] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    let active = true;
    void loadComposerDraft(key).then(async saved => {
      const restored = await Promise.all(saved.fileIds.map(async id => ({ id, file: await loadComposerFile(id) })));
      if (!active) return;
      if (restored.some(f => !f.file)) {
        setError("Some saved files are unavailable. Attach them again before sending.");
        saved = { ...saved, fileIds: restored.filter(f => f.file).map(f => f.id) };
      }
      draftRef.current = saved;
      setDraft(saved);
      setFiles(restored.filter(f => f.file) as { id: string; file: File }[]);
      onModeChange(saved.mode === "local");
    }).catch(() => {
      if (active) setError("Could not access saved drafts. Allow site storage and reload to use the local editor.");
    });
    return () => { active = false; };
  }, [key, onModeChange]);

  const slowConnection = latency !== null && latency > 250;
  useEffect(() => {
    if (!slowConnection) return;
    const timer = setTimeout(() => setSuggestLocal(true), 5000);
    return () => clearTimeout(timer);
  }, [slowConnection]);
  useEffect(() => {
    if (latency !== null && latency < 120) setSuggestLocal(false);
  }, [latency]);

  const update = (next: ComposerDraft) => {
    draftRef.current = next;
    setDraft(next);
    const generation = ++saveGeneration.current;
    setSaved(false);
    void saveComposerDraft(key, next).then(() => {
      if (mounted.current && generation === saveGeneration.current) setSaved(true);
    }).catch(() => { if (mounted.current) setError("Draft could not be saved on this device. Keep this screen open and try again."); });
  };
  const mode = (local: boolean) => {
    if (!draftRef.current || busyRef.current) return;
    update({ ...draftRef.current, mode: local ? "local" : "direct" });
    setSuggestionDismissed(true);
    onModeChange(local);
    setSettingsOpen(false);
  };
  const paste = async () => {
    const current = draftRef.current;
    if (!current || busyRef.current || current.pending) return;
    const start = current.mode === "local" ? input.current?.selectionStart ?? current.text.length : current.text.length;
    const end = current.mode === "local" ? input.current?.selectionEnd ?? start : start;
    busyRef.current = true; setBusy(true); setError(null);
    // Read during the click's activation; switch to a reviewable draft even
    // if the browser denies clipboard access, so native Paste remains usable.
    const reading = readClipboardText();
    const localDraft = { ...current, mode: "local" as const };
    update(localDraft); onModeChange(true);
    const wasFocused = document.activeElement === input.current;
    let caret = start;
    try {
      const text = await reading;
      if (!mounted.current || draftRef.current !== localDraft) return;
      if (!text) { setError("The clipboard has no text."); return; }
      const next = current.text.slice(0, start) + text + current.text.slice(end);
      if (next.length > 65536) { setError("This text is too long. Paste a smaller section (up to 65,536 characters)."); return; }
      update({ ...localDraft, text: next });
      caret = start + text.length;
    } catch {
      if (mounted.current) setError("Could not read the clipboard. Long-press the input box and choose Paste, or use Cmd/Ctrl+V.");
    } finally {
      busyRef.current = false;
      if (mounted.current) {
        setBusy(false);
        requestAnimationFrame(() => { if (wasFocused) input.current?.focus(); input.current?.setSelectionRange(caret, caret); });
      }
    }
  };
  const attach = async (chosen: File[]) => {
    const current = draftRef.current;
    if (!current || busyRef.current || current.pending) return;
    setError(null);
    if (files.length + chosen.length > 4 || files.reduce((n, f) => n + f.file.size, 0) + chosen.reduce((n, f) => n + f.size, 0) > MAX_BYTES) {
      setError("Attach up to 4 files, totaling at most 20 MB."); return;
    }
    busyRef.current = true; setBusy(true);
    const additions = chosen.map(file => ({ id: newComposerId(), file }));
    try {
      await Promise.all(additions.map(f => saveComposerFile(f.id, f.file)));
      if (!mounted.current) {
        await Promise.all(additions.map(f => removeComposerFile(f.id)));
        return;
      }
      setFiles(old => [...old, ...additions]);
      update({ ...draftRef.current!, fileIds: [...draftRef.current!.fileIds, ...additions.map(f => f.id)] });
    } catch { setError("Could not save the files. Your draft has been kept."); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  };
  const send = async () => {
    const current = draftRef.current;
    if (!current || busyRef.current || !canSend) return;
    busyRef.current = true; setBusy(true); setError(null); setNotice("Sending…");
    try {
      const message = current.pending ?? {
        id: newComposerId(), text: current.text,
        attachments: await Promise.all(files.map(async f => ({ filename: f.file.name, mime: f.file.type || "application/octet-stream", data: await fileBase64(f.file) }))),
      };
      const sending = { ...current, pending: message };
      // Persist the exact ID/content BEFORE dispatch; reload/retry only queries
      // the same durable send instead of creating a second command.
      await saveComposerDraft(key, sending);
      draftRef.current = sending; if (mounted.current) setDraft(sending);
      const receipt = await onSend(message);
      if (receipt.status === "delivered") {
        const cleared: ComposerDraft = { text: "", fileIds: [], mode: sending.mode };
        await saveComposerDraft(key, cleared);
        void Promise.all(current.fileIds.map(removeComposerFile)).catch(() => {});
        draftRef.current = cleared;
        if (mounted.current) { setDraft(cleared); setFiles([]); setNotice("Delivered to terminal"); }
      } else if (receipt.status === "failed") {
        const retryable = { ...sending, pending: undefined };
        await saveComposerDraft(key, retryable);
        draftRef.current = retryable;
        if (mounted.current) { setDraft(retryable); setError(receipt.detail); setNotice(null); }
      } else if (mounted.current) { setError(receipt.detail); setNotice(null); }
    } catch (cause) {
      if (mounted.current) { setError(cause instanceof Error ? cause.message : "Send failed. Your draft has been kept."); setNotice(null); }
    } finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  };

  const local = draft?.mode === "local";
  const locked = busy || !!draft?.pending;
  const handleKey = (data: string) => {
    if (!local || ctrlArmed || data === "\x1b" || data === "\x03") { onDirectAction(data); return; }
    if (composing.current) return;
    const current = draftRef.current;
    if (!current || busyRef.current) return;
    if (data === "\r") {
      if (current.pending || current.text.length || current.fileIds.length) void send();
      else onDirectAction(data);
      return;
    }
    if (current.pending) return;
    const result = editComposerText(current.text, input.current?.selectionStart ?? current.text.length, input.current?.selectionEnd ?? current.text.length, data);
    if (!result) return;
    if (result.text !== current.text) update({ ...current, text: result.text });
    // Commit selection after React updates the controlled input, without
    // focusing it or reopening an OS keyboard the user has dismissed.
    requestAnimationFrame(() => input.current?.setSelectionRange(result.caret, result.caret));
  };
  const long = expanded || !!draft?.text.includes("\n") || (draft?.text.length ?? 0) > 70;
  const content = <div data-testid="local-composer" hidden={hidden} style={{ position: "relative", flexShrink: 0, minWidth: 0, background: colors.background }}>
    {renderToolbar({ onKey: handleKey, onPaste: () => void paste(), onInputSettings: () => setSettingsOpen(value => !value),
      onChooseAttachment: local ? () => { if (!locked) setChoosingAttachment(true); } : undefined,
      onToggleKeyboard: () => {
        if (!local) { onToggleKeyboard(); return; }
        if (document.activeElement === input.current) { input.current?.blur(); onKeyboardVisible(false); }
        else { input.current?.focus(); }
      }, local, enterLabel: busy ? "Sending…" : draft?.pending ? "Check delivery" : "Enter", enterDisabled: local && busy })}
    {settingsOpen && <div ref={settings} role="dialog" aria-label="Input settings" style={{ position: "absolute", zIndex: 20, bottom: "100%", right: 8, width: 300, maxWidth: "calc(100% - 16px)", padding: 10, border: `1px solid ${colors.border}`, borderRadius: 14, background: colors.surface, boxShadow: `0 4px 20px ${colorAlpha.overlay}` }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>How to enter text<button style={button} aria-label="Close input settings" onClick={() => setSettingsOpen(false)}><X size={18} /></button></div>
      <button style={{ ...button, width: "100%", textAlign: "left", marginTop: 6, borderColor: !local ? colors.accent : colors.border, background: !local ? colorAlpha.accentSoft : colors.surface }} disabled={!draft || busy} aria-pressed={!local} onClick={() => mode(false)}>Type directly</button>
      <button style={{ ...button, width: "100%", textAlign: "left", marginTop: 6, borderColor: local ? colors.accent : colors.border, background: local ? colorAlpha.accentSoft : colors.surface }} disabled={!draft || busy} aria-pressed={local} onClick={() => mode(true)}>Write first, then send</button>
      <p style={{ fontSize: 12, color: colors.foregroundSecondary }}>Write first keeps typing on this device until Enter. Switch to direct typing to use the terminal’s slash-command menu.</p>
    </div>}
    {!hidden && !local && suggestLocal && !suggestionDismissed && <p style={{ color: colors.foregroundSecondary, fontSize: 12, margin: "4px 10px" }}>Slow connection? Choose “Write first, then send” in Input settings.</p>}
    {local && draft && <div style={{ padding: "0 10px 8px" }}>
      <div style={{ position: "relative" }}>
        <textarea ref={input} aria-label="Message to terminal" data-testid="composer-input" value={draft.text} disabled={locked} rows={expanded ? 5 : 1} wrap={expanded ? "soft" : "off"} maxLength={65536}
          placeholder="Write here · Enter to submit"
          onFocus={() => onKeyboardVisible(true)} onBlur={() => {
            // Some IMEs dismiss without delivering compositionend. Once the
            // editor loses focus, stale composition must not swallow toolbar keys.
            composing.current = false;
            onKeyboardVisible(false);
          }}
          onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
          onKeyDown={event => {
            if (!event.nativeEvent.isComposing && !composing.current && ctrlArmed && event.key.length === 1) {
              event.preventDefault(); onDirectAction(event.key); return;
            }
            if (event.key === "Escape") { event.preventDefault(); onDirectAction("\x1b"); return; }
            if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
              if (event.nativeEvent.isComposing || composing.current || event.keyCode === 229) return;
              event.preventDefault(); handleKey("\r");
            }
          }}
          onChange={e => update({ ...draftRef.current!, text: e.target.value })}
          onPaste={e => { const pasted = Array.from(e.clipboardData.files); if (pasted.length) { e.preventDefault(); void attach(pasted); } }}
          style={{ display: "block", boxSizing: "border-box", width: "100%", resize: "none", height: expanded ? 132 : 44, whiteSpace: expanded ? "pre-wrap" : "pre", background: colors.surface, color: colors.foreground, border: `1px solid ${colors.border}`, borderRadius: 8, padding: long ? "9px 48px 9px 10px" : "9px 10px", fontSize: 16, lineHeight: "24px", fontFamily: "var(--font-sans)" }} />
        {long && <button style={{ ...button, position: "absolute", top: 0, right: 0, height: 44, width: 44, padding: 0, border: 0 }} aria-label={expanded ? "Collapse editor" : "Expand editor"} aria-expanded={expanded} onMouseDown={e => e.preventDefault()} onClick={() => setExpanded(value => !value)}>{expanded ? <Minimize2 size={18} /> : <Maximize2 size={18} />}</button>}
      </div>
      <span data-testid="composer-save-status" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clipPath: "inset(50%)" }}>{saved ? "Saved on this device" : "Saving…"}</span>
      <div style={{ display: "flex", gap: 8, overflowX: "auto" }}>{files.map(({ id, file }) => <AttachmentPreview key={id} file={file} disabled={locked} onRemove={() => {
        update({ ...draftRef.current!, fileIds: draftRef.current!.fileIds.filter(f => f !== id) });
        setFiles(old => old.filter(f => f.id !== id)); void removeComposerFile(id).catch(() => {});
      }} />)}</div>
      <input data-testid="composer-photo-input" ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden onChange={e => { void attach(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
      <input data-testid="composer-document-input" ref={documentInput} type="file" multiple hidden onChange={e => { void attach(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
      {choosingAttachment && <AttachmentPicker onPhotos={() => fileInput.current?.click()} onFiles={() => documentInput.current?.click()} onClose={() => setChoosingAttachment(false)} />}
      {!canSend && <p style={{ fontSize: 12, color: colors.foregroundSecondary }}>Take control and reconnect to send to {title}. You can keep editing here.</p>}
      {draft.pending && !busy && <p style={{ fontSize: 12, color: colors.foregroundSecondary }}>Press Enter to check delivery. This draft stays locked until confirmed.</p>}
      {draft.pending && !busy && <button style={button} onClick={() => { void Promise.all(draft.fileIds.map(removeComposerFile)).catch(() => {}); update({ text: "", fileIds: [], mode: "local" }); setFiles([]); setError(null); setNotice(null); }}>Discard pending draft</button>}
    </div>}
    {notice && <div role="status" style={{ fontSize: 12, color: colors.foregroundSecondary, padding: "4px 10px" }}>{notice}</div>}
    {error && <div role="alert" style={{ fontSize: 12, color: colors.err, padding: "4px 10px" }}>{error}</div>}
  </div>;
  return portalTarget ? createPortal(content, portalTarget) : content;
}

function AttachmentPreview({ file, disabled, onRemove }: { file: File; disabled: boolean; onRemove: () => void }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => { const next = URL.createObjectURL(file); setUrl(next); return () => URL.revokeObjectURL(next); }, [file]);
  return <div style={{ position: "relative", flexShrink: 0, marginTop: 6 }}>
    {["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)
      ? <img src={url} alt={file.name || "Attached image"} style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 6 }} />
      : <div style={{ padding: "12px 26px 12px 10px", border: `1px solid ${colors.border}`, borderRadius: 6, maxWidth: 200, overflowWrap: "anywhere", fontSize: 12 }}>{file.name || "File"}</div>}
    <div style={{ fontSize: 11, color: colors.foregroundMuted, maxWidth: 200, overflowWrap: "anywhere" }}>{formatAttachmentSize(file.size)}</div>
    <button aria-label={`Remove ${file.name || "file"}`} disabled={disabled} onClick={onRemove} style={{ ...button, minHeight: 24, padding: "1px 6px", position: "absolute", right: 0, top: 0 }}>×</button>
  </div>;
}
