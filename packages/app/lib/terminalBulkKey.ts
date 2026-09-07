/** Some OS text services deliver a whole string in a legacy keypress. Its
 * charCode describes only the first UTF-16 unit; xterm's legacy path loses the
 * rest. Named keys and live composition must stay on their normal paths. */
export function bulkKeypressText(event: Pick<KeyboardEvent, "type" | "key" | "charCode" | "isComposing" | "ctrlKey" | "altKey" | "metaKey">): string | null {
  if (event.type !== "keypress" || event.isComposing || event.ctrlKey || event.altKey || event.metaKey) return null;
  if (event.key.length <= 1 || event.charCode === 0 || event.key.charCodeAt(0) !== event.charCode) return null;
  return event.key;
}
