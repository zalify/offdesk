import { useEffect, useState } from "react";

/** Gap between the floating update card and whatever it sits on. */
export const CARD_GAP = 12;

/** The card's `bottom`, in px: just above the key bar when one is on screen
 * (P02), else null and the card sits on the safe area. */
export function keyBarClearance(viewportHeight: number, keyBar: { top: number; height: number } | null): number | null {
  if (!keyBar || keyBar.height <= 0 || keyBar.top >= viewportHeight) return null;
  return Math.max(CARD_GAP, viewportHeight - keyBar.top + CARD_GAP);
}

/** The card is mounted above every screen, so it looks for the key bar
 * rather than being told: the bar comes and goes with the terminal, and
 * moves with the soft keyboard. Measured only while the card is up. */
export function useKeyBarClearance(active: boolean): number | null {
  const [bottom, setBottom] = useState<number | null>(null);
  useEffect(() => {
    if (!active) return;
    const measure = () => {
      const bar = document.querySelector<HTMLElement>(".offdesk-keybar");
      const rect = bar?.getBoundingClientRect();
      setBottom(keyBarClearance(window.innerHeight, rect ? { top: rect.top, height: rect.height } : null));
    };
    measure();
    const timer = setInterval(measure, 1000);
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    return () => {
      clearInterval(timer);
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
    };
  }, [active]);
  return bottom;
}
