import { readClipboardText } from "@/lib/readClipboardText";
import { AttachmentPicker, formatAttachmentSize } from "./AttachmentPicker";
import { useEffect, useRef, useState, type ReactNode, type CSSProperties } from "react";
import { ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Keyboard, Paperclip, ClipboardPaste, Copy, SquareDashed, LoaderCircle } from "lucide-react";
import "./ExtendedKeyBar.css";

export interface ExtendedKeyBarProps {
  onKey: (data: string) => void;
  onToggleKeyboard: () => void;
  onPasteText?: (text: string) => void;
  onAttachFile?: (file: File) => void | Promise<void>;
  onEnterSelectMode?: () => void;
  onExitSelectMode?: () => void;
  onCopySelection?: () => Promise<string | null> | string | null;
  selectMode?: boolean;
  keyboardVisible: boolean;
  isController: boolean;
  ctrlArmed?: boolean;
  onToggleCtrl?: () => void;
}

export function ExtendedKeyBar({ onKey, onToggleKeyboard, onPasteText, onAttachFile,
  onEnterSelectMode, onExitSelectMode, onCopySelection, selectMode = false, keyboardVisible, isController,
  ctrlArmed = false, onToggleCtrl }: ExtendedKeyBarProps) {
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [pasting, setPasting] = useState(false);
  const pastePending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const paste = async () => {
    if (!isController || !onPasteText || pastePending.current) return;
    pastePending.current = true; setPasting(true); setPasteError(null);
    try {
      let text: string;
      try { text = await readClipboardText(); }
      catch { throw new Error("Could not read the clipboard. Use your keyboard’s Paste action or Cmd/Ctrl+V."); }
      if (!mounted.current) return;
      if (!text) throw new Error("The clipboard has no text.");
      onPasteText(text);
    } catch (error) {
      if (mounted.current) setPasteError(error instanceof Error ? error.message : "Could not paste. Try again.");
    } finally {
      pastePending.current = false;
      if (mounted.current) setPasting(false);
    }
  };
  const bar = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const documentInput = useRef<HTMLInputElement>(null);
  const [keyWidth, setKeyWidth] = useState(48);
  const [edges, setEdges] = useState({ left: false, right: false });
  const [choosingAttachment, setChoosingAttachment] = useState(false);
  const [attachmentStatus, setAttachmentStatus] = useState<{ message: string; submitted: boolean } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [copying, setCopying] = useState(false);
  const selectionAvailable = !!(onEnterSelectMode && onExitSelectMode && onCopySelection);
  const selection = selectMode && selectionAvailable;
  const updateEdges = () => {
    const el = scroller.current;
    if (el) setEdges({ left: el.scrollLeft > 1, right: el.scrollWidth - el.clientWidth - el.scrollLeft > 1 });
  };
  useEffect(() => {
    const update = () => {
      if (bar.current) { const width = bar.current.clientWidth - 8; setKeyWidth(width / Math.max(7, Math.floor(width / 52))); }
      updateEdges();
    };
    const observer = new ResizeObserver(update);
    [bar.current, scroller.current, track.current].forEach(el => { if (el) observer.observe(el); });
    update();
    return () => observer.disconnect();
  }, [selection]);
  useEffect(() => {
    if (!attachmentStatus?.submitted) return;
    const timer = setTimeout(() => setAttachmentStatus(null), 5000);
    return () => clearTimeout(timer);
  }, [attachmentStatus]);
  const attach = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = "";
    if (!file || !onAttachFile || !isController || uploading) return;
    setUploading(true);
    const description = `${file.name} (${formatAttachmentSize(file.size)})`;
    setAttachmentStatus({ message: `Sending ${description}…`, submitted: false });
    try { await onAttachFile(file); setAttachmentStatus({ message: `Submitted ${description}. Check the terminal for its path.`, submitted: true }); }
    catch (error) { setAttachmentStatus({ message: error instanceof Error ? error.message : "Could not send the file. Try again.", submitted: false }); }
    finally { setUploading(false); }
  };
  const key = (label: string, data: string, id?: string, icon?: ReactNode) => <KeyButton key={data} label={label} testid={id}
    disabled={!isController} repeat={!!icon} onPress={() => onKey(data)}>{icon}</KeyButton>;
  return <div ref={bar} className="offdesk-keybar" data-testid="extended-keybar" style={{ "--key-width": `${keyWidth}px` } as CSSProperties}>
    {selection ? <div className="offdesk-selection-bar" data-testid="extended-keybar-select-mode">
      <button onClick={onExitSelectMode} disabled={copying} data-testid="extended-keybar-select-done">Done</button>
      <span>Drag on the terminal to select text</span>
      <button disabled={copying} data-testid="extended-keybar-copy" onClick={async () => {
        setCopying(true); try { await onCopySelection?.(); } finally { setCopying(false); }
      }}><Copy size={18} aria-hidden />{copying ? "Copying…" : "Copy"}</button>
    </div> : <>
      {pasteError && <div role="alert" className="offdesk-attachment-status">
        <span>{pasteError}</span><button aria-label="Dismiss paste error" onClick={() => setPasteError(null)}>Dismiss</button>
      </div>}
      {attachmentStatus && <div role="status" data-testid="attachment-status" className="offdesk-attachment-status">
        <span>{attachmentStatus.message}</span><button aria-label="Dismiss attachment status" onClick={() => setAttachmentStatus(null)}>Dismiss</button>
      </div>}
      <div className="offdesk-keybar-row" data-testid="keybar-fixed-row" role="group" aria-label="Frequent terminal keys">
        <KeyButton label="Ctrl+C" testid="extended-keybar-ctrl-c" disabled={!isController} accent onPress={() => onKey("\x03")} />
        {key("Esc", "\x1b", "extended-keybar-esc")}{key("Tab", "\t", "extended-keybar-tab")}{key("/", "/", "extended-keybar-slash")}
        <span className="offdesk-keybar-spacer" />
        {key("Arrow up", "\x1b[A", "extended-keybar-up", <ArrowUp size={18} aria-hidden />)}
        {key("Enter", "\r", "extended-keybar-enter")}
      </div>
      <div className="offdesk-keybar-row" data-testid="keybar-secondary-row">
        <KeyButton label={keyboardVisible ? "Hide keyboard" : "Show keyboard"} disabled={!isController} pressed={keyboardVisible}
          testid="extended-keybar-keyboard" onPress={onToggleKeyboard}><Keyboard size={18} aria-hidden /></KeyButton>
        <div className="offdesk-keybar-scroll-wrap" data-left={edges.left} data-right={edges.right}>
          <div ref={scroller} className="offdesk-keybar-scroll" onScroll={updateEdges} data-testid="keybar-scroll" role="group" aria-label="Input tools and symbols, scroll horizontally">
            <div ref={track} className="offdesk-keybar-track">
              {onPasteText && <KeyButton label="Paste" testid="extended-keybar-paste" disabled={!isController || pasting} onPress={() => void paste()}><ClipboardPaste size={18} aria-hidden /></KeyButton>}
              {onAttachFile && <KeyButton label={uploading ? "Uploading attachment" : "Attach photo or file"} testid="extended-keybar-attach"
                disabled={!isController || uploading} onPress={() => setChoosingAttachment(true)}>
                {uploading ? <LoaderCircle size={18} aria-hidden className="offdesk-keybar-spinner" data-testid="extended-keybar-attach-spinner" /> : <Paperclip size={18} aria-hidden />}
              </KeyButton>}
              {selectionAvailable && <KeyButton label="Select text to copy" testid="extended-keybar-select-toggle" disabled={!isController} onPress={() => onEnterSelectMode?.()}><SquareDashed size={18} aria-hidden /></KeyButton>}
              {onToggleCtrl && <KeyButton label="Ctrl" testid="extended-keybar-ctrl-latch" disabled={!isController} pressed={ctrlArmed} onPress={onToggleCtrl} />}
              {["Space", "@", "~", "|", "-", "_"].map(label => key(label, label === "Space" ? " " : label, label === "Space" ? "extended-keybar-space" : undefined))}
            </div>
          </div>
        </div>
        {key("Arrow left", "\x1b[D", "extended-keybar-left", <ArrowLeft size={18} aria-hidden />)}
        {key("Arrow down", "\x1b[B", "extended-keybar-down", <ArrowDown size={18} aria-hidden />)}
        {key("Arrow right", "\x1b[C", "extended-keybar-right", <ArrowRight size={18} aria-hidden />)}
      </div>
    </>}
    <input ref={fileInput} type="file" accept="image/*" hidden onChange={attach} data-testid="extended-keybar-file-input" disabled={!onAttachFile} />
    <input ref={documentInput} type="file" hidden onChange={attach} data-testid="extended-keybar-document-input" disabled={!onAttachFile} />
    {choosingAttachment && <AttachmentPicker onPhotos={() => fileInput.current?.click()} onFiles={() => documentInput.current?.click()} onClose={() => setChoosingAttachment(false)} />}
  </div>;
}

function KeyButton({ label, children, onPress, testid, disabled = false, repeat = false, accent = false, pressed }: {
  label: string; children?: ReactNode; onPress: () => void; testid?: string; disabled?: boolean; repeat?: boolean; accent?: boolean; pressed?: boolean;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const delay = useRef<ReturnType<typeof setTimeout> | null>(null);
  const interval = useRef<ReturnType<typeof setInterval> | null>(null);
  const press = useRef(onPress); press.current = onPress;
  const disabledRef = useRef(disabled); disabledRef.current = disabled;
  const gesture = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const stop = () => { if (delay.current) clearTimeout(delay.current); if (interval.current) clearInterval(interval.current); delay.current = null; interval.current = null; };
  useEffect(() => {
    const hidden = () => { if (document.hidden) stop(); };
    window.addEventListener("blur", stop); document.addEventListener("visibilitychange", hidden);
    return () => { stop(); window.removeEventListener("blur", stop); document.removeEventListener("visibilitychange", hidden); };
  }, []);
  useEffect(() => { if (disabled) stop(); }, [disabled]);
  useEffect(() => {
    const button = buttonRef.current;
    if (!button) return;
    const touchEnd = (event: TouchEvent) => {
      const current = gesture.current;
      if (!current || current.moved || event.touches.length > 0) return;
      // Cancelling pointerdown/mousedown does not cancel the touchend
      // default action in mobile WebViews. Consume the tap here so an
      // already-focused editable cannot reopen a dismissed OS keyboard.
      // React's touch listeners are passive: use a native non-passive one.
      event.preventDefault();
      stop();
      if (!disabledRef.current && !repeat) press.current();
      gesture.current = null;
    };
    button.addEventListener("touchend", touchEnd, { passive: false });
    return () => button.removeEventListener("touchend", touchEnd);
  }, [repeat]);
  return <button ref={buttonRef} type="button" className="offdesk-terminal-key" disabled={disabled} data-testid={testid} aria-label={label} title={label}
    aria-pressed={pressed} data-accent={accent} style={{ touchAction: repeat ? "none" : "pan-x" }}
    onPointerDown={event => {
      if (event.button !== 0 || disabled) return;
      gesture.current = { x: event.clientX, y: event.clientY, moved: false };
      // Cancel focus, not the horizontal scrolling gesture. mousedown is
      // canceled too because iOS synthesizes its own compatibility events.
      event.preventDefault();
      if (repeat) { stop(); press.current(); delay.current = setTimeout(() => { interval.current = setInterval(() => press.current(), 60); }, 350); }
    }}
    onMouseDown={event => event.preventDefault()}
    onPointerMove={event => { const g = gesture.current; if (g && Math.hypot(event.clientX - g.x, event.clientY - g.y) > 8) { g.moved = true; stop(); } }}
    onPointerUp={stop} onPointerLeave={stop}
    onPointerCancel={() => { if (gesture.current) gesture.current.moved = true; stop(); }}
    onContextMenu={event => { if (repeat) event.preventDefault(); }}
    onClick={event => {
      // Keyboard / assistive activation has detail=0. Pointer clicks on
      // repeat keys were already sent on down; swipes never activate keys.
      if (event.detail === 0 || (!repeat && !gesture.current?.moved)) onPress();
      gesture.current = null;
    }}>
    {children ?? label}
  </button>;
}
