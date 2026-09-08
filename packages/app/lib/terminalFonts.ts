export function quoteFontFamily(font: string): string {
  return `'${font.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

export const DEFAULT_TERMINAL_FONT = "Iosevka Term";
export const DEFAULT_TERMINAL_FONT_FAMILY = `${quoteFontFamily(DEFAULT_TERMINAL_FONT)}, monospace`;

export function resolveTerminalFontFamily(userFont: string | null | undefined): string {
  const font = userFont?.trim();
  return font && font !== DEFAULT_TERMINAL_FONT
    ? `${quoteFontFamily(font)}, ${DEFAULT_TERMINAL_FONT_FAMILY}`
    : DEFAULT_TERMINAL_FONT_FAMILY;
}
