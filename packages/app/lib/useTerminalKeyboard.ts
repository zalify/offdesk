import { useEffect } from "react";
import { createKeyboardViewportTracker } from "./terminalKeyboard";

const INPUT = '.xterm-helper-textarea, [data-testid="composer-input"]';

/** OS keyboard visibility and DOM focus are separate states. Release the stale
 * terminal focus when the IME closes, before another toolbar tap can reopen it. */
export function useTerminalKeyboard(enabled: boolean, onVisible: (visible: boolean) => void) {
  useEffect(() => {
    if (!enabled) return;
    const viewport = window.visualViewport;
    const measure = () => ({
      width: viewport?.width ?? window.innerWidth,
      height: viewport?.height ?? window.innerHeight,
      scale: viewport?.scale ?? 1,
    });
    const observe = createKeyboardViewportTracker(measure());
    let nativeVisibilityAvailable = false;
    const editable = () => {
      const active = document.activeElement;
      return active instanceof HTMLElement && active.matches(INPUT) ? active : null;
    };
    const dismissed = () => {
      editable()?.blur();
      onVisible(false);
    };
    const resized = () => {
      if (!nativeVisibilityAvailable && observe(measure(), !!editable())) dismissed();
    };
    const nativeVisibility = (event: Event) => {
      const visible: unknown = (event as CustomEvent).detail;
      if (typeof visible !== "boolean") return;
      nativeVisibilityAvailable = true;
      if (visible === false) dismissed();
      else if (visible === true && editable()) onVisible(true);
    };
    const focused = () => { if (editable()) onVisible(true); };
    const blurred = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement && event.target.matches(INPUT)) onVisible(false);
    };
    viewport?.addEventListener("resize", resized);
    window.addEventListener("resize", resized);
    window.addEventListener("offdesk:keyboard-visibility", nativeVisibility);
    document.addEventListener("focusin", focused);
    document.addEventListener("focusout", blurred);
    return () => {
      viewport?.removeEventListener("resize", resized);
      window.removeEventListener("resize", resized);
      window.removeEventListener("offdesk:keyboard-visibility", nativeVisibility);
      document.removeEventListener("focusin", focused);
      document.removeEventListener("focusout", blurred);
    };
  }, [enabled, onVisible]);
}
