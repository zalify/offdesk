export type BootStep = "signin" | "hub" | "terminal";

export const BOOT_STEPS: readonly BootStep[] = ["signin", "hub", "terminal"];

// Tips for a long load: each is a shipped phone feature, worded the way its
// controls are labelled.
export const BOOT_TIPS: readonly string[] = [
  "Swipe the title bar left or right to jump to the next or previous terminal.",
  "Swipe in from the edge of the screen to switch terminals.",
  "Tap the session title to see every session and start a new terminal.",
  "Long-press the title bar to close this terminal or open a new one beside it.",
  "Tap ctrl, then a letter on your keyboard, to send a shortcut like Ctrl+R.",
  "Hold bksp to keep deleting.",
  "Rearrange, hide or add keys in Settings → Terminal keys.",
  "Tap attach to send photos, videos or files; the terminal gets their paths.",
  "Tap select and drag across the terminal to copy text.",
  "Tap paste to paste your clipboard; nothing runs until you press enter.",
  "A terminal waiting for a yes/no shows up at the top; confirm it from there.",
  "Tap [b] to watch your agent's browser and take over when it needs you.",
  "Turn on View only from the [m] menu to stop accidental typing.",
];

let picked: [string, string] | null = null;

/** Two different tips, drawn once per page load. */
export function pickBootTips(random: () => number = Math.random): [string, string] {
  if (picked) return picked;
  picked = drawTwo(BOOT_TIPS, random);
  return picked;
}

export function drawTwo<T>(items: readonly T[], random: () => number): [T, T] {
  const first = Math.floor(random() * items.length) % items.length;
  const offset = 1 + (Math.floor(random() * (items.length - 1)) % (items.length - 1));
  return [items[first], items[(first + offset) % items.length]];
}
