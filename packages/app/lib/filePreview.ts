// Pure helpers for the file browser's preview: deciding what a file is,
// decoding text, and building the sandboxed document used for rich content.

export type PreviewKind = "image" | "markdown" | "docx" | "pdf" | "text" | "unsupported";

export interface PreviewInput {
  name: string;
  mime: string;
  bytes: Uint8Array;
}

export const MAX_PREVIEW_TEXT_CHARS = 1_000_000;

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
  svg: "image/svg+xml",
};

const MARKDOWN_EXTS = new Set(["md", "markdown", "mdx"]);

const TEXT_EXTS = new Set([
  "txt", "log", "text", "js", "mjs", "cjs", "ts", "tsx", "jsx", "json", "jsonc", "json5",
  "yaml", "yml", "toml", "rs", "py", "go", "sh", "bash", "zsh", "fish", "css", "scss",
  "less", "html", "htm", "xml", "csv", "tsv", "ini", "conf", "cfg", "env", "sql", "java",
  "kt", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "rb", "php", "lua", "pl", "r", "vue",
  "svelte", "gradle", "properties", "lock", "gitignore", "dockerignore", "editorconfig",
  "tex", "rst", "diff", "patch", "service", "proto", "graphql", "tf",
]);

const TEXT_NAMES = new Set([
  "dockerfile", "makefile", "readme", "license", "changelog", "procfile", "gemfile",
  "rakefile", "justfile", "cmakelists.txt",
]);

const TEXT_APP_MIME = /^application\/(json|xml|javascript|x-javascript|x-sh|x-shellscript|yaml|x-yaml|toml|sql|x-httpd-php|x-www-form-urlencoded)$|\+(json|xml|yaml)$/;

export function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

export function imageMimeFor(name: string, mime: string): string | null {
  const byExt = IMAGE_MIME_BY_EXT[extensionOf(name)];
  if (byExt) return byExt;
  const lower = mime.toLowerCase();
  if (lower.startsWith("image/") && lower !== "image/svg+xml") return lower;
  if (lower === "image/svg+xml") return lower;
  return null;
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Strict decode: UTF-8, then GB18030 without replacement chars. Null when neither fits. */
export function decodeTextStrict(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // fall through
  }
  try {
    const text = new TextDecoder("gb18030").decode(bytes);
    return text.includes("�") ? null : text;
  } catch {
    return null;
  }
}

/** True when the first 8 KB holds no NUL byte (a quick binary check). */
export function looksLikeText(bytes: Uint8Array): boolean {
  const head = Math.min(bytes.length, 8192);
  for (let i = 0; i < head; i++) if (bytes[i] === 0) return false;
  return true;
}

export type PreviewAnalysis =
  | { kind: "text"; text: string }
  | { kind: "image"; mime: string }
  | { kind: "markdown"; text: string }
  | { kind: "docx" }
  | { kind: "pdf" }
  | { kind: "unsupported" };

/** Extension first, then mime, then content sniffing. */
export function analyzeFile({ name, mime, bytes }: PreviewInput): PreviewAnalysis {
  const ext = extensionOf(name);
  const lowerName = name.toLowerCase();
  const lowerMime = mime.toLowerCase().split(";")[0].trim();

  const image = imageMimeFor(name, lowerMime);
  if (image) return { kind: "image", mime: image };
  if (ext === "docx") return { kind: "docx" };
  if (ext === "pdf" || lowerMime === "application/pdf") return { kind: "pdf" };

  if (MARKDOWN_EXTS.has(ext) || lowerMime === "text/markdown") {
    const text = decodeTextStrict(bytes);
    if (text !== null) return { kind: "markdown", text: stripBom(text) };
    return { kind: "unsupported" };
  }

  const knownText =
    TEXT_EXTS.has(ext) ||
    TEXT_NAMES.has(lowerName) ||
    lowerMime.startsWith("text/") ||
    TEXT_APP_MIME.test(lowerMime);
  if (knownText) {
    if (!looksLikeText(bytes)) return { kind: "unsupported" };
    const text =
      decodeTextStrict(bytes) ?? new TextDecoder("utf-8").decode(bytes);
    return { kind: "text", text: stripBom(text) };
  }

  // Unknown type: only treat it as text when the content really is.
  if (looksLikeText(bytes)) {
    const text = decodeTextStrict(bytes);
    if (text !== null) return { kind: "text", text: stripBom(text) };
  }
  return { kind: "unsupported" };
}

export function truncateText(
  text: string,
  max = MAX_PREVIEW_TEXT_CHARS,
): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  let end = max;
  // Do not cut a surrogate pair in half.
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), truncated: true };
}

export interface PreviewTheme {
  bg: string;
  fg: string;
  muted: string;
  line: string;
  accent: string;
  codeBg: string;
}

export const FALLBACK_PREVIEW_THEME: PreviewTheme = {
  bg: "rgb(255 251 244)",
  fg: "rgb(43 35 64)",
  muted: "rgb(110 100 130)",
  line: "rgb(230 207 174)",
  accent: "rgb(174 61 46)",
  codeBg: "rgb(255 244 227)",
};

const SAFE_COLOR = /^[#\w\s(),.%/-]{1,64}$/;

function safeColor(value: string, fallback: string): string {
  return SAFE_COLOR.test(value) ? value : fallback;
}

/**
 * The app's colors are `rgb(var(--color-x))`, which cannot resolve inside an
 * isolated iframe, so read the concrete "R G B" triples off the document.
 */
export function resolvePreviewTheme(root: HTMLElement = document.documentElement): PreviewTheme {
  const style = getComputedStyle(root);
  const read = (name: string, fallback: string) => {
    const raw = style.getPropertyValue(name).trim();
    return /^\d+\s+\d+\s+\d+$/.test(raw) ? `rgb(${raw})` : fallback;
  };
  const f = FALLBACK_PREVIEW_THEME;
  return {
    bg: read("--color-bg-0", f.bg),
    fg: read("--color-fg-0", f.fg),
    muted: read("--color-fg-2", f.muted),
    line: read("--color-line", f.line),
    accent: read("--color-accent", f.accent),
    codeBg: read("--color-bg-1", f.codeBg),
  };
}

export const PREVIEW_CSP =
  "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:";

/**
 * Wraps untrusted HTML (from markdown or docx) in a complete document for an
 * `<iframe sandbox="" srcDoc>`. The CSP forbids scripts and network access.
 */
export function buildPreviewDocument(bodyHtml: string, theme: PreviewTheme): string {
  const f = FALLBACK_PREVIEW_THEME;
  const t = {
    bg: safeColor(theme.bg, f.bg),
    fg: safeColor(theme.fg, f.fg),
    muted: safeColor(theme.muted, f.muted),
    line: safeColor(theme.line, f.line),
    accent: safeColor(theme.accent, f.accent),
    codeBg: safeColor(theme.codeBg, f.codeBg),
  };
  const css = `
html { background: ${t.bg}; color: ${t.fg}; }
body { margin: 0 auto; max-width: 860px; padding: 20px 24px 48px; box-sizing: border-box;
  font: 15px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB",
  "Microsoft YaHei", "Noto Sans CJK SC", sans-serif; overflow-wrap: anywhere; }
h1, h2, h3, h4, h5, h6 { line-height: 1.3; margin: 1.4em 0 0.6em; font-weight: 600; }
h1 { font-size: 1.7em; border-bottom: 1px solid ${t.line}; padding-bottom: 0.3em; }
h2 { font-size: 1.4em; border-bottom: 1px solid ${t.line}; padding-bottom: 0.25em; }
h3 { font-size: 1.2em; }
p, ul, ol, blockquote, pre, table { margin: 0 0 1em; }
a { color: ${t.accent}; }
img { max-width: 100%; height: auto; }
table { border-collapse: collapse; max-width: 100%; display: block; overflow-x: auto; }
th, td { border: 1px solid ${t.line}; padding: 6px 10px; vertical-align: top; }
th { background: ${t.codeBg}; font-weight: 600; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.9em; }
code { background: ${t.codeBg}; padding: 0.15em 0.4em; border-radius: 4px; }
pre { background: ${t.codeBg}; border: 1px solid ${t.line}; border-radius: 6px; padding: 12px 14px; overflow-x: auto; }
pre code { background: none; padding: 0; }
blockquote { margin-left: 0; padding: 0.1em 1em; color: ${t.muted}; border-left: 3px solid ${t.line}; }
hr { border: none; border-top: 1px solid ${t.line}; margin: 1.5em 0; }
`;
  return (
    `<!doctype html><html><head>` +
    `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">` +
    `<meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<base target="_blank">` +
    `<style>${css}</style></head><body>${bodyHtml}</body></html>`
  );
}
