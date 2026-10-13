import type { TerminalInfo } from "@offdesk/shared";

/** Short marker for a terminal an API-token client (the CLI an agent
 *  drives) opened: "agent" or "agent · claude". Null when a person did. */
export function terminalOpenerText(terminal: TerminalInfo): string | null {
  const opener = terminal.opened_by;
  if (!opener) return null;
  const label = opener.label?.trim();
  return label ? `agent · ${label}` : "agent";
}

/** The marker spelled out, for tooltips and screen readers. */
export function terminalOpenerDescription(terminal: TerminalInfo): string | null {
  const opener = terminal.opened_by;
  if (!opener) return null;
  const via = opener.kind === "cli" ? " via the offdesk CLI" : "";
  const label = opener.label?.trim();
  return `Opened by an agent${via}${label ? ` (${label})` : ""}`;
}
