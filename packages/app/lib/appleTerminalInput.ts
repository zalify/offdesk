export interface TextEditSnapshot {
  value: string;
  start: number;
  end: number;
}

/** A terminal can safely mirror an IME's tail replacement with DEL + text.
 * Never erase arbitrary terminal content to reconcile an unrelated DOM edit. */
export function terminalTailEdit(before: TextEditSnapshot, after: TextEditSnapshot): string | null {
  if (before.end !== before.value.length || after.start !== after.end || after.end !== after.value.length) return null;
  let common = 0;
  const oldChars = Array.from(before.value);
  const newChars = Array.from(after.value);
  while (common < oldChars.length && common < newChars.length && oldChars[common] === newChars[common]) common++;
  return "\x7f".repeat(oldChars.length - common) + newChars.slice(common).join("");
}

interface AppleTextInputOptions {
  textarea: HTMLTextAreaElement;
  composing: () => boolean;
  keyHandled: () => boolean;
  disabled: () => boolean;
  commit: (text: string) => void;
}

/** Apple IME punctuation and text services use input after keyCode 229's
 * timer has already fired. Own committed edits at input time, before xterm's
 * insertText-only handler; leave composition and physical keys with xterm. */
export function attachAppleTerminalInput(options: AppleTextInputOptions): () => void {
  const { textarea } = options;
  // xterm registers a capture listener on the textarea before addons attach.
  // Capture on its parent so the edit has exactly one owner, even when xterm's
  // own insertText path would also accept it (no preceding keydown).
  const inputRoot = textarea.parentElement ?? textarea;
  let before: TextEditSnapshot | null = null;
  const snapshot = (): TextEditSnapshot => ({ value: textarea.value, start: textarea.selectionStart, end: textarea.selectionEnd });
  const supported = (event: InputEvent) => ["insertText", "insertReplacementText", "insertFromDictation", "deleteContentBackward"].includes(event.inputType);
  const onBeforeInput = (event: Event) => {
    if (event.target !== textarea) return;
    const input = event as InputEvent;
    before = !input.isComposing && supported(input) && !options.composing() ? snapshot() : null;
  };
  const onInput = (event: Event) => {
    if (event.target !== textarea) return;
    const input = event as InputEvent;
    const previous = before;
    before = null;
    if (options.disabled() || input.isComposing || options.composing() || !supported(input)) return;
    // Hardware keypress already emitted its character. Let xterm deduplicate.
    if (options.keyHandled()) return;
    let text = previous ? terminalTailEdit(previous, snapshot()) : null;
    // Some text services omit beforeinput. An insertion is still explicit;
    // a deletion/replacement without its range is not safe to infer.
    if (!previous && input.inputType === "insertText" && input.data) text = input.data;
    if (text === null) return;
    event.stopImmediatePropagation();
    options.commit(text);
  };
  const reset = () => { before = null; };
  inputRoot.addEventListener("beforeinput", onBeforeInput, true);
  inputRoot.addEventListener("input", onInput, true);
  textarea.addEventListener("blur", reset);
  return () => {
    inputRoot.removeEventListener("beforeinput", onBeforeInput, true);
    inputRoot.removeEventListener("input", onInput, true);
    textarea.removeEventListener("blur", reset);
  };
}
