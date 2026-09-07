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

interface IosTextInputOptions {
  textarea: HTMLTextAreaElement;
  composing: () => boolean;
  keyHandled: () => boolean;
  disabled: () => boolean;
  commit: (text: string) => void;
}

/** iOS Chinese punctuation and text services use input after keyCode 229's
 * timer has already fired. Own committed edits at input time, before xterm's
 * insertText-only handler; leave composition and physical keys with xterm. */
export function attachIosTerminalInput(options: IosTextInputOptions): () => void {
  const { textarea } = options;
  let before: TextEditSnapshot | null = null;
  const snapshot = (): TextEditSnapshot => ({ value: textarea.value, start: textarea.selectionStart, end: textarea.selectionEnd });
  const supported = (event: InputEvent) => ["insertText", "insertReplacementText", "insertFromDictation", "deleteContentBackward"].includes(event.inputType);
  const onBeforeInput = (event: Event) => {
    const input = event as InputEvent;
    before = !input.isComposing && supported(input) && !options.composing() ? snapshot() : null;
  };
  const onInput = (event: Event) => {
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
  textarea.addEventListener("beforeinput", onBeforeInput, true);
  textarea.addEventListener("input", onInput, true);
  textarea.addEventListener("blur", reset);
  return () => {
    textarea.removeEventListener("beforeinput", onBeforeInput, true);
    textarea.removeEventListener("input", onInput, true);
    textarea.removeEventListener("blur", reset);
  };
}
