// Pure helpers behind the desktop agent-browser overlay (the top-bar Browser
// button): which tab is selected, what a typed address means, and which
// handoffs and reclaims are new.

import type { AgentBrowserDialog, AgentBrowserInfo, TerminalInfo } from "@offdesk/shared";
import { displayTerminalTitle } from "./displayTerminalTitle";

/** What a tab or row calls a browser: its title, else the host of its URL. */
export function browserLabel(browser: AgentBrowserInfo): string {
  const title = browser.title.trim();
  if (title) return title;
  try {
    return new URL(browser.url).host || browser.url || "browser";
  } catch {
    return browser.url || "browser";
  }
}

/**
 * The name of the terminal whose agent opened this browser, as the workspace
 * shows it. Null when the opener is unknown or its terminal is gone.
 */
export function browserOwnerLabel(
  browser: AgentBrowserInfo,
  terminals: readonly TerminalInfo[],
): string | null {
  if (!browser.opener_terminal_id) return null;
  const owner = terminals.find((terminal) => terminal.id === browser.opener_terminal_id);
  return owner ? displayTerminalTitle(owner) : null;
}

/** Opened in an isolated private context (no shared logins). */
export function browserIsPrivate(browser: AgentBrowserInfo): boolean {
  return browser.private === true;
}

/** Toast for a new handoff: names the asking session when it is known. */
export function handoffToastText(
  browser: AgentBrowserInfo,
  terminals: readonly TerminalInfo[],
): string {
  const owner = browserOwnerLabel(browser, terminals);
  return `${owner ?? "The agent"} needs you in ${browserLabel(browser)}: ${browser.handoff?.reason ?? ""}`;
}

/** The agent asked for help and nobody has taken over yet. */
export function browserNeedsPerson(browser: AgentBrowserInfo): boolean {
  return browser.handoff !== undefined && browser.controller !== "human";
}

/** True when this device holds control of the browser. */
export function browserControlledBy(
  browser: AgentBrowserInfo,
  deviceId: string | null,
): boolean {
  return (
    deviceId !== null &&
    browser.controller === "human" &&
    browser.controller_device_id === deviceId
  );
}

/** How the desktop overlay shows: hidden, a small picture-in-picture window, or the full dialog. */
export type BrowserOverlayMode = "closed" | "mini" | "expanded";

/** The Browser button: anything but the full dialog opens it; the full dialog closes. */
export function toggleBrowserOverlayMode(mode: BrowserOverlayMode): BrowserOverlayMode {
  return mode === "expanded" ? "closed" : "expanded";
}

/** Opening the file browser drops the full dialog; a mini window stays. */
export function browserOverlayModeForFiles(mode: BrowserOverlayMode): BrowserOverlayMode {
  return mode === "expanded" ? "closed" : mode;
}

export type MiniBrowserStatus = {
  text: string;
  tone: "agent" | "needsYou" | "you" | "other";
};

/** The mini window's one-line state of a browser, from this device's point of view. */
export function miniBrowserStatus(
  browser: AgentBrowserInfo,
  deviceId: string | null,
): MiniBrowserStatus {
  if (browserNeedsPerson(browser)) {
    const reason = browser.handoff?.reason.trim();
    return { text: reason ? `needs you: ${reason}` : "needs you", tone: "needsYou" };
  }
  if (browserControlledBy(browser, deviceId)) return { text: "you in control", tone: "you" };
  if (browser.controller === "human") {
    return { text: "another device in control", tone: "other" };
  }
  return { text: "agent in control", tone: "agent" };
}

/** First tab asking for a person, else the first opened by `terminalId`, else null. */
function preferredBrowser(
  browsers: AgentBrowserInfo[],
  terminalId: string | null | undefined,
  remembered: string | null | undefined,
): AgentBrowserInfo | null {
  const asking = browsers.find(browserNeedsPerson);
  if (asking) return asking;
  if (!terminalId) return null;
  const owned = browsers.filter((browser) => browser.opener_terminal_id === terminalId);
  return owned.find((browser) => browser.id === remembered) ?? owned[0] ?? null;
}

/**
 * The tab to show: the remembered one while it still exists. When it is gone
 * (or none was picked) the pick order applies: a tab asking for a person, a tab
 * opened by `activeTerminalId`, else the first. `awaitingId` is a tab just
 * opened whose browser event has not arrived yet; nothing is selected until it
 * does, so another tab does not flash in between. Terminal focus changes never
 * move an existing selection.
 */
export function pickSelectedBrowserId(
  browsers: AgentBrowserInfo[],
  remembered: string | null | undefined,
  awaitingId: string | null = null,
  activeTerminalId: string | null = null,
): string | null {
  if (remembered && browsers.some((browser) => browser.id === remembered)) {
    return remembered;
  }
  if (awaitingId !== null && remembered === awaitingId) return null;
  return (
    preferredBrowser(browsers, activeTerminalId, remembered)?.id ?? browsers[0]?.id ?? null
  );
}

/**
 * The tab to land on when the overlay opens: (a) one asking for a person,
 * (b) one opened by the active terminal, (c) the last one viewed on this
 * machine, (d) the first.
 */
export function pickBrowserToOpen(
  browsers: AgentBrowserInfo[],
  remembered: string | null | undefined,
  activeTerminalId: string | null = null,
): string | null {
  const preferred = preferredBrowser(browsers, activeTerminalId, remembered);
  if (preferred) return preferred.id;
  return pickSelectedBrowserId(browsers, remembered);
}

/** Browsers in `next` that started asking a person for help since `prev`. */
export function findNewHandoffs(
  prev: AgentBrowserInfo[],
  next: AgentBrowserInfo[],
): AgentBrowserInfo[] {
  const before = new Map(prev.map((browser) => [browser.id, browser]));
  return next.filter((browser) => {
    if (!browserNeedsPerson(browser)) return false;
    const old = before.get(browser.id);
    return (
      !old ||
      old.handoff === undefined ||
      old.handoff.requested_at !== browser.handoff!.requested_at
    );
  });
}

/** Browsers in `next` whose `reclaimed` is new since `prev`: absent before, or a different `at`. */
export function findNewReclaims(
  prev: AgentBrowserInfo[],
  next: AgentBrowserInfo[],
): AgentBrowserInfo[] {
  const before = new Map(prev.map((browser) => [browser.id, browser]));
  return next.filter((browser) => {
    if (!browser.reclaimed) return false;
    const old = before.get(browser.id);
    return !old || old.reclaimed === undefined || old.reclaimed.at !== browser.reclaimed.at;
  });
}

/**
 * The tab to switch to after the browsers changed from `prev` to `next`
 * while `selectedId` was shown, or null to stay: a window the shown page
 * just opened comes to the front, and when the shown tab goes away (a popup
 * that closed itself) the page that opened it comes back.
 */
export function followPopups(
  prev: AgentBrowserInfo[],
  next: AgentBrowserInfo[],
  selectedId: string | null,
): string | null {
  if (selectedId === null) return null;
  const before = new Set(prev.map((browser) => browser.id));
  const opened = next.find(
    (browser) => !before.has(browser.id) && browser.opener_browser_id === selectedId,
  );
  if (opened) return opened.id;
  if (next.some((browser) => browser.id === selectedId)) return null;
  const opener = prev.find((browser) => browser.id === selectedId)?.opener_browser_id;
  return opener && next.some((browser) => browser.id === opener) ? opener : null;
}

/** Title, body and button labels of a page's JavaScript dialog, as Chrome words them. */
export function dialogText(dialog: AgentBrowserDialog): {
  title: string;
  message: string;
  accept: string;
  dismiss: string | null;
} {
  if (dialog.kind === "beforeunload") {
    return {
      title: "Leave site?",
      message: dialog.message || "Changes you made may not be saved.",
      accept: "Leave",
      dismiss: "Stay",
    };
  }
  return {
    title: "This page says",
    message: dialog.message,
    accept: "OK",
    dismiss: dialog.kind === "alert" ? null : "Cancel",
  };
}

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const OPAQUE_SCHEME = /^(about|data|file|blob|chrome|view-source):/i;
const LOOPBACK_HOST = /^(localhost|\[::1\]|\d{1,3}(\.\d{1,3}){3})(:\d+)?([/?#]|$)/i;

/**
 * What a typed address means: a full URL as is, a bare host (`aliyun.com`,
 * `example.com/a?b=1`) with `https://`, and localhost or an IPv4 literal with
 * `http://` (dev servers rarely speak TLS). Null when there is nothing usable.
 */
export function normalizeBrowserUrl(input: string): string | null {
  const text = input.trim();
  if (!text || /\s/.test(text)) return null;
  if (HAS_SCHEME.test(text) || OPAQUE_SCHEME.test(text)) return text;
  return `${LOOPBACK_HOST.test(text) ? "http" : "https"}://${text}`;
}
