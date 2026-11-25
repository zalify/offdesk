import type { TerminalInfo } from "@offdesk/shared";

const LEGACY_TERMINAL_TITLE = /^Terminal [0-9a-f]{8}$/;

// Known CLI tools whose raw argv (e.g. "agy --dangerously-sk ~/p/webmux") often
// leaks into the terminal title when the process doesn't set an OSC title.
const CLI_WITH_FLAGS_RE =
  /^(agy|claude|codex|gemini|aider|opencode|goose|fish|zsh|bash|sh|nvim|vim|hx)\s+(.*)$/i;

function basenameFromPath(path: string | null | undefined): string | null {
  if (!path) return null;
  const trimmed = path.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  if (trimmed === "~" || trimmed === "/") return trimmed;
  const idx = trimmed.lastIndexOf("/");
  const base = idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
  return base || null;
}

/**
 * Clean up raw CLI command-line titles (e.g. `agy --dangerously-sk ~/p/webmux`
 * -> `agy · webmux`) while preserving explicit conversation or custom titles.
 */
function cleanCliTitle(title: string, cwd?: string | null): string {
  const match = CLI_WITH_FLAGS_RE.exec(title);
  if (!match) return title;

  const cmd = match[1];
  const rest = match[2].trim();
  const tokens = rest.split(/\s+/).filter(Boolean);
  const hasFlag = tokens.some((token) => token.startsWith("-"));
  if (!hasFlag) return title;

  // Keep the last non-flag token if it looks like a path or directory name.
  let pathHint: string | null = null;
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const token = tokens[i];
    if (!token.startsWith("-") && (token.includes("/") || token === "~")) {
      pathHint = token;
      break;
    }
  }

  const dirName = basenameFromPath(pathHint) ?? basenameFromPath(cwd);
  return dirName ? `${cmd} · ${dirName}` : cmd;
}

export function displayTerminalTitle(terminal: TerminalInfo): string {
  const title = terminal.title?.trim();
  if (!title || LEGACY_TERMINAL_TITLE.test(title)) return "shell";
  return cleanCliTitle(title, terminal.cwd);
}

/** Shorten `/home/<user>/...` or `/Users/<user>/...` to `~/...` for pane headers. */
export function shortenCwd(cwd: string | null | undefined): string {
  if (!cwd) return "";
  return cwd.replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/, "~");
}
