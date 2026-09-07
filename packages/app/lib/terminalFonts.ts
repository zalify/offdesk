export const PREFERRED_TERMINAL_FONTS = [
  "Maple Mono NF CN",
  "Noto Sans Mono CJK SC",
  "JetBrains Mono",
  "JetBrainsMono Nerd Font",
  "JetBrainsMono NF",
  "JetBrainsMono Nerd Font Mono",
  "JetBrainsMono NFM",
  "Fira Code",
  "FiraCode Nerd Font",
  "FiraCode NF",
  "Cascadia Code",
  "CaskaydiaCove Nerd Font",
  "CaskaydiaCove NF",
  "Source Code Pro",
  "SauceCodePro Nerd Font",
  "Hack",
  "Hack Nerd Font",
  "Ubuntu Mono",
  "UbuntuMono Nerd Font",
  "Consolas",
  "Menlo",
  "Monaco",
  "DejaVu Sans Mono",
] as const;

export function quoteFontFamily(font: string): string {
  return `'${font.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

export const DEFAULT_TERMINAL_FONT_FAMILY = [
  ...PREFERRED_TERMINAL_FONTS.map(quoteFontFamily),
  "monospace",
].join(", ");

export function resolveTerminalFontFamily(
  userFont: string | null | undefined,
): string {
  const font = userFont?.trim();
  return font
    ? `${quoteFontFamily(font)}, monospace`
    : DEFAULT_TERMINAL_FONT_FAMILY;
}
