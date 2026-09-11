// Match the terminal's conventional Shift encodings, not browser key events.
// https://invisible-island.net/xterm/ctlseqs/ctlseqs.html (PC-style function keys)
// Leave IME commits, pasted text and already-modified sequences intact.
export function shiftKeyTransform(data: string, ctrl = false): string {
  if (data === "\t") return "\x1b[Z";
  const cursor = /^\x1b(?:\[|O)([ABCDHF])$/.exec(data);
  if (cursor) return `\x1b[1;${ctrl ? 6 : 2}${cursor[1]}`;
  if (/^[a-z]$/.test(data)) return data.toUpperCase();
  const plain = "`1234567890-=[]\\;',./";
  const shifted = '~!@#$%^&*()_+{}|:"<>?';
  const index = data.length === 1 ? plain.indexOf(data) : -1;
  return index < 0 ? data : shifted[index];
}
