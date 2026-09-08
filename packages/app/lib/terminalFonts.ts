export function quoteFontFamily(font: string): string {
  return `'${font.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

export const DEFAULT_TERMINAL_FONT = "JetBrains Mono";
export const TERMINAL_SYMBOL_FONT = "Offdesk Terminal Symbols";
export const DEFAULT_TERMINAL_FONT_FAMILY = `${quoteFontFamily(DEFAULT_TERMINAL_FONT)}, ${quoteFontFamily(TERMINAL_SYMBOL_FONT)}, monospace`;

export function resolveTerminalFontFamily(userFont: string | null | undefined): string {
  const font = userFont?.trim();
  return font && font !== DEFAULT_TERMINAL_FONT
    ? `${quoteFontFamily(font)}, ${DEFAULT_TERMINAL_FONT_FAMILY}`
    : DEFAULT_TERMINAL_FONT_FAMILY;
}
