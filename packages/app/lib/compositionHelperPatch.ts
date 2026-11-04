import type { Terminal } from "@xterm/xterm";
import { attachAppleTerminalInput } from "@/lib/appleTerminalInput";

export interface XtermCompositionHelper {
  _isComposing: boolean;
  _compositionPosition: { start: number; end: number };
  _compositionSuffix: string;
  _isSendingComposition: boolean;
  _dataAlreadySent: string;
  _textareaChangeTimer?: number;
  _textarea: HTMLTextAreaElement;
  _compositionView: HTMLElement;
  _coreService: { triggerDataEvent(data: string, wasUserInput?: boolean): void };
  compositionstart(): void;
  _finalizeComposition(waitForPropagation: boolean): void;
  _handleAnyTextareaChanges(): void;
}

export type TerminalWithCompositionHelper = Terminal & {
  _core?: { _compositionHelper?: XtermCompositionHelper; _keyPressHandled?: boolean; _keyDownHandled?: boolean };
};

export function patchCompositionHelperSendRace(term: Terminal): () => void {
  // xterm's CompositionHelper finalizes a composition with a setTimeout(0)
  // that computes the text to send from LIVE textarea state at run time:
  // the region end comes from the newest composition's live position (or
  // live value.length), the #3191 dedup offset from live _dataAlreadySent,
  // and cancellation is one shared _isSendingComposition boolean that every
  // compositionend re-arms. On a starved main thread (slow phones, CI) the
  // 0ms timers queue behind input tasks; a stale timer then fires with an
  // over-wide region covering later commits, and the timers that owned
  // those commits are cancelled — the same commit reaches onData twice
  // (upstream xterm.js#5023, unfixed as of 6.1.0-beta.303).
  //
  // Workaround: track how much of the textarea prefix has already been
  // emitted (`emittedPrefixLength`) and clamp every deferred send region to
  // start at or after it. Content is never compared, so legitimate repeated
  // text (测测) still flows; each textarea position is simply emitted at
  // most once.
  //
  // Invariant: the watermark never exceeds the current textarea length. A
  // textarea shorter than the watermark proves the emitted prefix is gone
  // (xterm clears it on Enter / Ctrl+C keydown, on blur and after paste,
  // none of which this patch observes), so resync() lowers the watermark at
  // compositionstart and at the top of every _handleAnyTextareaChanges. In
  // the #5023 race the textarea still holds the emitted text, so resync
  // leaves the watermark alone there and the dedup is intact.
  const helper = (term as TerminalWithCompositionHelper)._core
    ?._compositionHelper;
  if (
    !helper ||
    typeof helper._finalizeComposition !== "function" ||
    typeof helper._handleAnyTextareaChanges !== "function" ||
    !helper._textarea
  ) {
    return () => {};
  }

  let emittedPrefixLength = 0;

  const resync = (): void => {
    if (helper._textarea.value.length < emittedPrefixLength) {
      emittedPrefixLength = helper._textarea.value.length;
    }
  };

  const originalCompositionStart = helper.compositionstart.bind(helper);
  const originalFinalize = helper._finalizeComposition.bind(helper);
  const originalHandleAnyTextareaChanges =
    helper._handleAnyTextareaChanges.bind(helper);

  helper.compositionstart = () => {
    originalCompositionStart();
    resync();
  };

  helper._finalizeComposition = (waitForPropagation: boolean): void => {
    helper._compositionView.classList.remove("active");
    helper._isComposing = false;

    if (!waitForPropagation) {
      // Cancel any delayed composition send requests and send the input
      // immediately (upstream verbatim, plus watermark advance).
      helper._isSendingComposition = false;
      const input = helper._textarea.value.substring(
        helper._compositionPosition.start,
        helper._compositionPosition.end,
      );
      emittedPrefixLength = Math.max(
        emittedPrefixLength,
        helper._compositionPosition.start + input.length,
      );
      helper._coreService.triggerDataEvent(input, true);
      return;
    }

    const currentCompositionPosition = {
      start: helper._compositionPosition.start,
      end: helper._compositionPosition.end,
    };
    const currentCompositionSuffix = helper._compositionSuffix;

    helper._isSendingComposition = true;
    setTimeout(() => {
      if (!helper._isSendingComposition) {
        return;
      }
      helper._isSendingComposition = false;
      // Upstream #3191 guard, then the watermark clamp: never re-emit a
      // textarea prefix any sender (this timer, the 229 diff timer, or the
      // sync finalize) has already accounted for — even if a newer
      // compositionstart reset _dataAlreadySent in between.
      const start = Math.max(
        currentCompositionPosition.start + helper._dataAlreadySent.length,
        emittedPrefixLength,
      );
      let input: string;
      if (helper._isComposing) {
        // Use the start position of the new composition to get the string
        // if a new composition has started. Math.max guards against
        // substring's argument-swap when the watermark is past it.
        input = helper._textarea.value.substring(
          start,
          Math.max(start, helper._compositionPosition.start),
        );
      } else {
        const value = helper._textarea.value;
        const valueEnd =
          currentCompositionSuffix.length > 0 &&
          value.endsWith(currentCompositionSuffix)
            ? value.length - currentCompositionSuffix.length
            : value.length;
        input = value.substring(start, Math.max(start, valueEnd));
      }
      if (input.length > 0) {
        emittedPrefixLength = start + input.length;
        helper._coreService.triggerDataEvent(input, true);
      }
    }, 0);
  };

  helper._handleAnyTextareaChanges = (): void => {
    resync();
    if (helper._textareaChangeTimer) {
      return;
    }
    const oldValue = helper._textarea.value;
    helper._textareaChangeTimer = window.setTimeout(() => {
      helper._textareaChangeTimer = undefined;
      // Ignore if a composition has started since the timeout
      if (helper._isComposing) {
        return;
      }
      const newValue = helper._textarea.value;
      if (newValue.length > oldValue.length) {
        // IMEs append at the caret; skip any prefix a composition finalize
        // already emitted while this timer was starved.
        const input = newValue.substring(
          Math.max(emittedPrefixLength, oldValue.length),
        );
        helper._dataAlreadySent = input;
        if (input.length > 0) {
          helper._coreService.triggerDataEvent(input, true);
        }
      } else if (newValue.length < oldValue.length) {
        helper._dataAlreadySent = newValue.replace(oldValue, "");
        // C0.DEL, matching upstream's shrink branch.
        helper._coreService.triggerDataEvent("\x7f", true);
      } else if (newValue !== oldValue) {
        helper._dataAlreadySent = newValue;
        helper._coreService.triggerDataEvent(newValue, true);
      } else {
        return;
      }
      // Whatever is now in the textarea has been accounted for.
      emittedPrefixLength = newValue.length;
    }, 0);
  };

  const apple = /Mac|iPad|iPhone|iPod/.test(navigator.userAgent) || navigator.platform === "MacIntel";
  const core = (term as TerminalWithCompositionHelper)._core;
  const removeAppleInput = apple ? attachAppleTerminalInput({
    textarea: helper._textarea,
    composing: () => helper._isComposing || helper._isSendingComposition,
    keyHandled: () => !!core?._keyPressHandled || !!core?._keyDownHandled,
    disabled: () => !!term.options.screenReaderMode,
    commit: (text) => {
      if (helper._textareaChangeTimer !== undefined) window.clearTimeout(helper._textareaChangeTimer);
      helper._textareaChangeTimer = undefined;
      helper._dataAlreadySent = "";
      emittedPrefixLength = helper._textarea.value.length;
      if (text) helper._coreService.triggerDataEvent(text, true);
    },
  }) : () => {};

  return () => {
    removeAppleInput();
    helper.compositionstart = originalCompositionStart;
    helper._finalizeComposition = originalFinalize;
    helper._handleAnyTextareaChanges = originalHandleAnyTextareaChanges;
  };
}
