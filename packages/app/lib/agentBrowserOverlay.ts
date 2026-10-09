// Pure helpers behind the desktop agent-browser overlay (the top-bar Browser
// button): which tab is selected, what a typed address means, and which
// handoffs and reclaims are new.

import type { AgentBrowserDialog, AgentBrowserInfo } from "@offdesk/shared";

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

/**
 * The tab to show: the remembered one while it still exists, else the first
 * remaining. `awaitingId` is a tab just opened whose browser event has not
 * arrived yet; nothing is selected until it does, so the first tab does not
 * flash in between.
 */
export function pickSelectedBrowserId(
  browsers: AgentBrowserInfo[],
  remembered: string | null | undefined,
  awaitingId: string | null = null,
): string | null {
  if (remembered && browsers.some((browser) => browser.id === remembered)) {
    return remembered;
  }
  if (awaitingId !== null && remembered === awaitingId) return null;
  return browsers[0]?.id ?? null;
}

/** The tab to land on when the overlay opens: one asking for help wins. */
export function pickBrowserToOpen(
  browsers: AgentBrowserInfo[],
  remembered: string | null | undefined,
): string | null {
  const asking = browsers.find(browserNeedsPerson);
  if (asking) return asking.id;
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
