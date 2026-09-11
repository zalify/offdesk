import { useKeyBarLayout, type KeyBarKey, type KeyBarLayout } from "@/lib/keyBarPreferences";
import { readClipboardText } from "@/lib/readClipboardText";
import { AttachmentPicker, AttachmentReview, formatAttachmentSize } from "./AttachmentPicker";
import { useEffect, useRef, useState, type ReactNode, type CSSProperties } from "react";
import { ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Keyboard, Paperclip, ClipboardPaste, Copy, SquareDashed, LoaderCircle, ArrowBigUp as Shift, Delete } from "lucide-react";
import "./ExtendedKeyBar.css";

export interface ExtendedKeyBarProps {
  layout?: KeyBarLayout;
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
  shiftArmed?: boolean;
  onToggleShift?: () => void;
  onShiftPress?: () => void;
  onShiftRelease?: (cancelled: boolean) => void;
}

export function ExtendedKeyBar({ layout: layoutOverride, onKey, onToggleKeyboard, onPasteText, onAttachFile,
  onEnterSelectMode, onExitSelectMode, onCopySelection, selectMode = false, keyboardVisible, isController,
  ctrlArmed = false, onToggleCtrl, shiftArmed = false, onToggleShift, onShiftPress, onShiftRelease }: ExtendedKeyBarProps) {
  const savedLayout = useKeyBarLayout();
  const layout = layoutOverride ?? savedLayout;
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
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [reviewingAttachments, setReviewingAttachments] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const uploadPending = useRef(false);
  const attachHandler = useRef(onAttachFile); attachHandler.current = onAttachFile;
  const controller = useRef(isController); controller.current = isController;
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
  const attach = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []); event.target.value = "";
    if (!files.length || !onAttachFile || !isController || uploadPending.current) return;
    setPendingFiles(current => [...current, ...files]);
    setUploadError(null);
    setReviewingAttachments(true);
  };
  const sendAttachments = async () => {
    if (uploadPending.current || !controller.current || !attachHandler.current || !pendingFiles.length) return;
    uploadPending.current = true; setUploading(true); setUploadError(null);
    const batch = pendingFiles.slice();
    try {
      // Read/encode one file at a time, so selecting many large photos does
      // not allocate all their Base64 representations on the phone at once.
      for (const file of batch) {
        if (!mounted.current) return;
        if (!controller.current || !attachHandler.current) throw new Error("Take control to send the remaining attachments.");
        await attachHandler.current(file);
        if (!mounted.current) return;
        setPendingFiles(current => current.slice(1));
      }
      setReviewingAttachments(false);
      const description = batch.length === 1
        ? `${batch[0].name} (${formatAttachmentSize(batch[0].size)})`
        : `${batch.length} attachments`;
      setAttachmentStatus({ message: `Submitted ${description}. Check the terminal for its path.`, submitted: true });
    } catch (error) {
      if (mounted.current) setUploadError(error instanceof Error ? error.message : "Could not send the file. Try again.");
    } finally {
      uploadPending.current = false;
      if (mounted.current) setUploading(false);
    }
  };
  const key = (label: string, data: string, id?: string, icon?: ReactNode, repeat: boolean | "hold" = false) => <KeyButton key={data} label={label} testid={id}
    disabled={!isController} repeat={repeat} onPress={() => onKey(data)}>{icon}</KeyButton>;
  const renderKey = (id: KeyBarKey): ReactNode => {
    const simple: Partial<Record<KeyBarKey, [string, string]>> = {
      esc: ["Esc", "\x1b"], tab: ["Tab", "\t"], slash: ["/", "/"], space: ["Space", " "],
      at: ["@", "@"], tilde: ["~", "~"], pipe: ["|", "|"], dash: ["-", "-"], underscore: ["_", "_"],
      home: ["Home", "\x1b[H"], end: ["End", "\x1b[F"], "ctrl-d": ["Ctrl+D", "\x04"],
      "ctrl-z": ["Ctrl+Z", "\x1a"], "ctrl-l": ["Ctrl+L", "\x0c"],
    };
    const data = simple[id];
    if (data) return key(data[0], data[1], `extended-keybar-${id}`);
    switch (id) {
      case "ctrl-c": return <KeyButton key={id} label="Ctrl+C" testid="extended-keybar-ctrl-c" disabled={!isController} accent onPress={() => onKey("\x03")} />;
      case "shift-tab": return key("Shift+Tab", "\x1b[Z", "extended-keybar-shift-tab", <><Shift size={13} aria-hidden /><span>Tab</span></>);
      case "backspace": return key("Backspace", "\x7f", "extended-keybar-backspace", <Delete size={18} aria-hidden />, "hold");
      case "shift": return onToggleShift && onShiftPress && onShiftRelease && <ShiftButton key={id} disabled={!isController} pressed={shiftArmed}
        onToggle={onToggleShift} onStart={onShiftPress} onEnd={onShiftRelease} />;
      case "paste": return onPasteText && <KeyButton key={id} label="Paste" testid="extended-keybar-paste" disabled={!isController || pasting} onPress={() => void paste()}><ClipboardPaste size={18} aria-hidden /></KeyButton>;
      case "attach": return onAttachFile && <KeyButton key={id} label={uploading ? "Uploading attachment" : "Attach photo or file"} testid="extended-keybar-attach"
        disabled={!isController || uploading} onPress={() => setChoosingAttachment(true)}>
        {uploading ? <LoaderCircle size={18} aria-hidden className="offdesk-keybar-spinner" data-testid="extended-keybar-attach-spinner" /> : <Paperclip size={18} aria-hidden />}
      </KeyButton>;
      case "select-toggle": return selectionAvailable && <KeyButton key={id} label="Select text to copy" testid="extended-keybar-select-toggle" disabled={!isController} onPress={() => onEnterSelectMode?.()}><SquareDashed size={18} aria-hidden /></KeyButton>;
      case "ctrl-latch": return onToggleCtrl && <KeyButton key={id} label="Ctrl" testid="extended-keybar-ctrl-latch" disabled={!isController} pressed={ctrlArmed} onPress={onToggleCtrl} />;
    }
  };
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
        {layout.primary.map(renderKey)}
        <span className="offdesk-keybar-spacer" />
        {key("Arrow up", "\x1b[A", "extended-keybar-up", <ArrowUp size={18} aria-hidden />, true)}
        {key("Enter", "\r", "extended-keybar-enter")}
      </div>
      <div className="offdesk-keybar-row" data-testid="keybar-secondary-row">
        <KeyButton label={keyboardVisible ? "Hide keyboard" : "Show keyboard"} disabled={!isController} pressed={keyboardVisible}
          testid="extended-keybar-keyboard" onPress={onToggleKeyboard}><Keyboard size={18} aria-hidden /></KeyButton>
        <div className="offdesk-keybar-scroll-wrap" data-left={edges.left} data-right={edges.right}>
          <div ref={scroller} className="offdesk-keybar-scroll" onScroll={updateEdges} data-testid="keybar-scroll" role="group" aria-label="Input tools and symbols, scroll horizontally">
            <div ref={track} className="offdesk-keybar-track">
              {layout.secondary.map(renderKey)}
            </div>
          </div>
        </div>
        {key("Arrow left", "\x1b[D", "extended-keybar-left", <ArrowLeft size={18} aria-hidden />, true)}
        {key("Arrow down", "\x1b[B", "extended-keybar-down", <ArrowDown size={18} aria-hidden />, true)}
        {key("Arrow right", "\x1b[C", "extended-keybar-right", <ArrowRight size={18} aria-hidden />, true)}
      </div>
    </>}
    <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={attach} data-testid="extended-keybar-file-input" disabled={!onAttachFile} />
    <input ref={documentInput} type="file" multiple hidden onChange={attach} data-testid="extended-keybar-document-input" disabled={!onAttachFile} />
    {reviewingAttachments && <AttachmentReview files={pendingFiles} uploading={uploading} error={uploadError}
      canSend={isController && !!onAttachFile} onSend={() => void sendAttachments()}
      onRemove={index => setPendingFiles(current => current.filter((_, i) => i !== index))}
      onCancel={() => { if (!uploadPending.current) { setPendingFiles([]); setReviewingAttachments(false); setUploadError(null); } }} />}
    {choosingAttachment && <AttachmentPicker onPhotos={() => fileInput.current?.click()} onFiles={() => documentInput.current?.click()} onClose={() => setChoosingAttachment(false)} />}
  </div>;
}

function KeyButton({ label, children, onPress, testid, disabled = false, repeat = false, accent = false, pressed }: {
  label: string; children?: ReactNode; onPress: () => void; testid?: string; disabled?: boolean; repeat?: boolean | "hold"; accent?: boolean; pressed?: boolean;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const delay = useRef<ReturnType<typeof setTimeout> | null>(null);
  const interval = useRef<ReturnType<typeof setInterval> | null>(null);
  const press = useRef(onPress); press.current = onPress;
  const disabledRef = useRef(disabled); disabledRef.current = disabled;
  const repeated = useRef(false);
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
      if (!current || current.moved || !Array.from(event.changedTouches).some(touch => button.contains(touch.target as Node))) return;
      // Cancelling pointerdown/mousedown does not cancel the touchend
      // default action in mobile WebViews. Consume the tap here so an
      // already-focused editable cannot reopen a dismissed OS keyboard.
      // React's touch listeners are passive: use a native non-passive one.
      event.preventDefault();
      stop();
      if (!disabledRef.current && (!repeat || (repeat === "hold" && !repeated.current))) press.current();
      gesture.current = null;
    };
    button.addEventListener("touchend", touchEnd, { passive: false });
    return () => button.removeEventListener("touchend", touchEnd);
  }, [repeat]);
  return <button ref={buttonRef} type="button" className="offdesk-terminal-key" disabled={disabled} data-testid={testid} aria-label={label} title={label}
    aria-pressed={pressed} data-accent={accent} style={{ touchAction: repeat === true ? "none" : "pan-x" }}
    onPointerDown={event => {
      if (event.button !== 0 || disabled) return;
      gesture.current = { x: event.clientX, y: event.clientY, moved: false };
      repeated.current = false;
      // Cancel focus, not the horizontal scrolling gesture. mousedown is
      // canceled too because iOS synthesizes its own compatibility events.
      event.preventDefault();
      if (repeat) {
        stop();
        if (repeat === true) press.current();
        delay.current = setTimeout(() => {
          repeated.current = true;
          press.current();
          interval.current = setInterval(() => press.current(), 60);
        }, 350);
      }
    }}
    onMouseDown={event => event.preventDefault()}
    onPointerMove={event => { const g = gesture.current; if (g && Math.hypot(event.clientX - g.x, event.clientY - g.y) > 8) { g.moved = true; stop(); } }}
    onPointerUp={stop} onPointerLeave={stop}
    onPointerCancel={() => { if (gesture.current) gesture.current.moved = true; stop(); }}
    onContextMenu={event => { if (repeat) event.preventDefault(); }}
    onClick={event => {
      // Keyboard / assistive activation has detail=0. Pointer clicks on
      // repeat keys were already sent on down; swipes never activate keys.
      if (event.detail === 0 || ((!repeat || (repeat === "hold" && !repeated.current)) && !gesture.current?.moved)) onPress();
      gesture.current = null;
    }}>
    {children ?? label}
  </button>;
}

function ShiftButton({ disabled, pressed, onStart, onEnd, onToggle }: {
  disabled: boolean; pressed: boolean; onStart: () => void; onEnd: (cancelled: boolean) => void; onToggle: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const pointer = useRef<number | null>(null);
  const end = useRef(onEnd); end.current = onEnd;
  useEffect(() => {
    const cancel = () => { pointer.current = null; end.current(true); };
    const hidden = () => { if (document.hidden) cancel(); };
    const touchEnd = (event: TouchEvent) => event.preventDefault();
    const button = ref.current;
    button?.addEventListener("touchend", touchEnd, { passive: false });
    window.addEventListener("blur", cancel); document.addEventListener("visibilitychange", hidden);
    return () => {
      cancel(); button?.removeEventListener("touchend", touchEnd);
      window.removeEventListener("blur", cancel); document.removeEventListener("visibilitychange", hidden);
    };
  }, []);
  useEffect(() => { if (disabled) { pointer.current = null; end.current(true); } }, [disabled]);
  return <button ref={ref} type="button" className="offdesk-terminal-key" data-testid="extended-keybar-shift"
    aria-label="Shift" title="Shift — tap for the next key, or hold to combine keys" aria-pressed={pressed} disabled={disabled}
    style={{ touchAction: "none" }}
    onPointerDown={event => {
      if (disabled || event.button !== 0 || pointer.current !== null) return;
      event.preventDefault(); pointer.current = event.pointerId;
      event.currentTarget.setPointerCapture(event.pointerId); onStart();
    }}
    onPointerUp={event => { if (pointer.current === event.pointerId) { pointer.current = null; onEnd(false); } }}
    onPointerCancel={() => { pointer.current = null; onEnd(true); }}
    onLostPointerCapture={() => { if (pointer.current !== null) { pointer.current = null; onEnd(true); } }}
    onMouseDown={event => event.preventDefault()} onContextMenu={event => event.preventDefault()}
    onClick={event => { if (event.detail === 0) onToggle(); }}><Shift size={18} aria-hidden /></button>;
}
