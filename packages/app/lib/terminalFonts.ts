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

// Terminal fonts the app ships (public/fonts): the same on every device.
export const BUNDLED_TERMINAL_FONTS = [DEFAULT_TERMINAL_FONT, "Geist Mono", "Fira Code", "IBM Plex Mono", "Source Code Pro"];
// Fonts a terminal can use only where they are installed: offered only then.
export const SYSTEM_TERMINAL_FONTS = [
  "Maple Mono NF CN", "Noto Sans Mono CJK SC", "Menlo", "Monaco", "Cascadia Code", "Consolas",
  "Hack", "Inconsolata", "Ubuntu Mono", "Noto Sans Mono", "Courier New",
];
// Interface fonts: Geist and Geist Mono ship with the app; the rest are offered
// only where installed. "System UI" is the platform's own and always there.
export const BUNDLED_UI_FONTS = ["Geist Mono", "Geist", "System UI"];
export const SYSTEM_UI_FONTS = [
  "Inter", "Roboto", "Segoe UI", "Helvetica Neue", "Arial", "SF Pro", "Noto Sans", "Open Sans", "Lato", "Source Sans Pro",
];

type Measure = (font: string) => number;
const SAMPLE = "mmmmmmmmmmlli1WQ@#0O中";
const GENERICS = ["monospace", "serif", "sans-serif"];

function canvasMeasure(): Measure | null {
  if (typeof document === "undefined") return null;
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return null;
  return (font) => {
    context.font = `72px ${font}`;
    return context.measureText(SAMPLE).width;
  };
}

/** Whether this device draws `font` itself. A missing font falls back to the
 *  generic family after it, so its text measures exactly like that generic
 *  one against all three. A canvas draws what the terminal would. */
export function isFontInstalled(font: string, measure: Measure | null = canvasMeasure()): boolean {
  if (!measure) return false;
  return GENERICS.some((generic) => measure(`${quoteFontFamily(font)}, ${generic}`) !== measure(generic));
}

const cache = new Map<string, boolean>();
const installed = (font: string) => {
  if (!cache.has(font)) cache.set(font, isFontInstalled(font));
  return cache.get(font)!;
};

/** The terminal fonts to offer here: the bundled ones, then those installed. */
export function availableTerminalFonts(): string[] {
  return [...BUNDLED_TERMINAL_FONTS, ...SYSTEM_TERMINAL_FONTS.filter(installed)];
}

/** The interface fonts to offer here, the same way. */
export function availableUiFonts(): string[] {
  return [...BUNDLED_UI_FONTS, ...SYSTEM_UI_FONTS.filter(installed)];
}
