import { describe, expect, it } from "vitest";
import type { AgentBrowserInfo, TerminalInfo } from "@offdesk/shared";
import {
  browserControlledBy,
  browserIsPrivate,
  browserLabel,
  browserOwnerLabel,
  handoffToastText,
  browserNeedsPerson,
  dialogText,
  findNewHandoffs,
  findNewReclaims,
  browserOverlayModeForFiles,
  followPopups,
  miniBrowserStatus,
  toggleBrowserOverlayMode,
  normalizeBrowserUrl,
  pickBrowserToOpen,
  pickSelectedBrowserId,
} from "./agentBrowserOverlay";

const browser = (
  id: string,
  extra: Partial<AgentBrowserInfo> = {},
): AgentBrowserInfo => ({ id, url: `https://${id}.test/`, title: id, ...extra });

describe("pickSelectedBrowserId", () => {
  const list = [browser("a"), browser("b")];
  it("keeps the remembered tab while it exists", () => {
    expect(pickSelectedBrowserId(list, "b")).toBe("b");
  });
  it("falls back to the first remaining tab", () => {
    expect(pickSelectedBrowserId(list, "gone")).toBe("a");
    expect(pickSelectedBrowserId(list, null)).toBe("a");
  });
  it("selects nothing without browsers", () => {
    expect(pickSelectedBrowserId([], "a")).toBeNull();
  });
  it("waits for a tab that was just opened", () => {
    expect(pickSelectedBrowserId(list, "new", "new")).toBeNull();
    expect(pickSelectedBrowserId([...list, browser("new")], "new", "new")).toBe("new");
  });
});

describe("pickBrowserToOpen", () => {
  it("prefers a tab the agent needs help in", () => {
    const list = [
      browser("a"),
      browser("b", { handoff: { reason: "log in", requested_at: 1 } }),
    ];
    expect(pickBrowserToOpen(list, "a")).toBe("b");
  });
  it("ignores a handoff someone already took over", () => {
    const list = [
      browser("a"),
      browser("b", {
        controller: "human",
        controller_device_id: "d",
        handoff: { reason: "x", requested_at: 1 },
      }),
    ];
    expect(pickBrowserToOpen(list, "a")).toBe("a");
  });
});

describe("handoff helpers", () => {
  const asking = (at: number) =>
    browser("a", { handoff: { reason: "captcha", requested_at: at } });
  it("flags a pending handoff only while the agent is in control", () => {
    expect(browserNeedsPerson(asking(1))).toBe(true);
    expect(browserNeedsPerson({ ...asking(1), controller: "human" })).toBe(false);
    expect(browserNeedsPerson(browser("a"))).toBe(false);
  });
  it("reports a handoff that is new or re-requested", () => {
    expect(findNewHandoffs([browser("a")], [asking(1)]).map((b) => b.id)).toEqual(["a"]);
    expect(findNewHandoffs([], [asking(1)])).toHaveLength(1);
    expect(findNewHandoffs([asking(1)], [asking(1)])).toHaveLength(0);
    expect(findNewHandoffs([asking(1)], [asking(2)])).toHaveLength(1);
    expect(findNewHandoffs([asking(1)], [browser("a")])).toHaveLength(0);
  });
  it("recognises this device's control", () => {
    const mine = browser("a", { controller: "human", controller_device_id: "me" });
    expect(browserControlledBy(mine, "me")).toBe(true);
    expect(browserControlledBy(mine, "other")).toBe(false);
    expect(browserControlledBy(mine, null)).toBe(false);
  });
});

describe("findNewReclaims", () => {
  const reclaimed = (at: number, device_id?: string) =>
    browser("a", { reclaimed: { reason: "need it", at, device_id } });
  it("reports a reclaim that is new or has a different time", () => {
    expect(findNewReclaims([browser("a")], [reclaimed(1)]).map((b) => b.id)).toEqual(["a"]);
    expect(findNewReclaims([], [reclaimed(1)])).toHaveLength(1);
    expect(findNewReclaims([reclaimed(1)], [reclaimed(2)])).toHaveLength(1);
  });
  it("ignores an unchanged or cleared reclaim", () => {
    expect(findNewReclaims([reclaimed(1)], [reclaimed(1)])).toHaveLength(0);
    expect(findNewReclaims([reclaimed(1)], [browser("a")])).toHaveLength(0);
    expect(findNewReclaims([], [browser("a")])).toHaveLength(0);
  });
});

describe("normalizeBrowserUrl", () => {
  it("adds https to bare hosts", () => {
    expect(normalizeBrowserUrl("aliyun.com")).toBe("https://aliyun.com");
    expect(normalizeBrowserUrl("  example.com/a?b=1 ")).toBe("https://example.com/a?b=1");
  });
  it("keeps full URLs", () => {
    expect(normalizeBrowserUrl("http://x.test/")).toBe("http://x.test/");
    expect(normalizeBrowserUrl("about:blank")).toBe("about:blank");
    expect(normalizeBrowserUrl("file:///tmp/a.html")).toBe("file:///tmp/a.html");
  });
  it("uses http for loopback and IPv4 hosts", () => {
    expect(normalizeBrowserUrl("localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeBrowserUrl("127.0.0.1:8080/x")).toBe("http://127.0.0.1:8080/x");
    expect(normalizeBrowserUrl("localhost.example.com")).toBe("https://localhost.example.com");
  });
  it("rejects empty or spaced input", () => {
    expect(normalizeBrowserUrl("  ")).toBeNull();
    expect(normalizeBrowserUrl("foo bar")).toBeNull();
  });
});

describe("browserLabel", () => {
  it("prefers the title, then the host, then the raw url", () => {
    expect(browserLabel(browser("a", { title: " Docs " }))).toBe("Docs");
    expect(
      browserLabel(browser("a", { title: "", url: "https://example.com/x?y=1" })),
    ).toBe("example.com");
    expect(browserLabel(browser("a", { title: "", url: "about:blank" }))).toBe(
      "about:blank",
    );
    expect(browserLabel(browser("a", { title: "", url: "" }))).toBe("browser");
  });
});

describe("followPopups", () => {
  const opener = browser("a");
  const popup = browser("p", { opener_browser_id: "a" });

  it("brings a window the shown page opened to the front", () => {
    expect(followPopups([opener], [opener, popup], "a")).toBe("p");
  });

  it("ignores windows opened by a tab that is not shown, and old ones", () => {
    expect(followPopups([opener, browser("b")], [opener, browser("b"), popup], "b")).toBeNull();
    expect(followPopups([opener, popup], [opener, popup], "a")).toBeNull();
    expect(followPopups([opener], [opener, popup], null)).toBeNull();
  });

  it("goes back to the opener when the shown popup closes", () => {
    expect(followPopups([opener, popup], [opener], "p")).toBe("a");
    // Its opener is gone too: the usual fallback picks a tab.
    expect(followPopups([opener, popup], [browser("c")], "p")).toBeNull();
    // A tab without an opener closing: nothing to follow.
    expect(followPopups([opener, browser("b")], [browser("b")], "a")).toBeNull();
  });
});

describe("dialogText", () => {
  it("words alerts, confirms and prompts like Chrome", () => {
    expect(dialogText({ kind: "alert", message: "Saved" })).toEqual({
      title: "This page says",
      message: "Saved",
      accept: "OK",
      dismiss: null,
    });
    expect(dialogText({ kind: "confirm", message: "Sure?" }).dismiss).toBe("Cancel");
    expect(dialogText({ kind: "prompt", message: "Name?" }).dismiss).toBe("Cancel");
  });

  it("asks before leaving a page", () => {
    expect(dialogText({ kind: "beforeunload", message: "" })).toEqual({
      title: "Leave site?",
      message: "Changes you made may not be saved.",
      accept: "Leave",
      dismiss: "Stay",
    });
  });
});

describe("browser overlay modes", () => {
  it("the button opens closed and mini to expanded, and closes expanded", () => {
    expect(toggleBrowserOverlayMode("closed")).toBe("expanded");
    expect(toggleBrowserOverlayMode("mini")).toBe("expanded");
    expect(toggleBrowserOverlayMode("expanded")).toBe("closed");
  });
  it("opening files closes only the expanded dialog", () => {
    expect(browserOverlayModeForFiles("expanded")).toBe("closed");
    expect(browserOverlayModeForFiles("mini")).toBe("mini");
    expect(browserOverlayModeForFiles("closed")).toBe("closed");
  });
});

describe("miniBrowserStatus", () => {
  it("says who is in control", () => {
    expect(miniBrowserStatus(browser("a"), "me")).toEqual({
      text: "agent in control",
      tone: "agent",
    });
    const mine = browser("a", { controller: "human", controller_device_id: "me" });
    expect(miniBrowserStatus(mine, "me")).toEqual({ text: "you in control", tone: "you" });
    expect(miniBrowserStatus(mine, "other").tone).toBe("other");
  });
  it("shows the handoff reason when the agent needs the person", () => {
    const asking = browser("a", { handoff: { reason: "Please log in", requested_at: 1 } });
    expect(miniBrowserStatus(asking, "me")).toEqual({
      text: "needs you: Please log in",
      tone: "needsYou",
    });
  });
});

const term = (id: string, title: string): TerminalInfo => ({
  id,
  machine_id: "m",
  title,
  cwd: "/tmp",
  cols: 80,
  rows: 24,
  reachable: true,
});

describe("browserOwnerLabel", () => {
  const terminals = [term("t1", "api work"), term("t2", "Terminal 0123abcd")];
  it("uses the name the workspace shows for the opener terminal", () => {
    expect(browserOwnerLabel(browser("a", { opener_terminal_id: "t1" }), terminals)).toBe("api work");
    expect(browserOwnerLabel(browser("a", { opener_terminal_id: "t2" }), terminals)).toBe("shell");
  });
  it("is null without an opener or when the terminal is unknown", () => {
    expect(browserOwnerLabel(browser("a"), terminals)).toBeNull();
    expect(browserOwnerLabel(browser("a", { opener_terminal_id: "gone" }), terminals)).toBeNull();
  });
});

describe("browserIsPrivate", () => {
  it("is true only for private: true", () => {
    expect(browserIsPrivate(browser("a", { private: true }))).toBe(true);
    expect(browserIsPrivate(browser("a", { private: false }))).toBe(false);
    expect(browserIsPrivate(browser("a"))).toBe(false);
  });
});

describe("handoffToastText", () => {
  const handoff = { reason: "log in", requested_at: 1 };
  it("names the asking session when known", () => {
    const b = browser("a", { opener_terminal_id: "t1", handoff });
    expect(handoffToastText(b, [term("t1", "api work")])).toBe("api work needs you in a: log in");
  });
  it("keeps the generic wording when unknown", () => {
    expect(handoffToastText(browser("a", { handoff }), [])).toBe("The agent needs you in a: log in");
  });
});

describe("tab pick order", () => {
  const list = [
    browser("a", { opener_terminal_id: "t1" }),
    browser("b", { opener_terminal_id: "t2" }),
    browser("c", { opener_terminal_id: "t2" }),
    browser("d"),
  ];
  it("on open: asking, then the active terminal's, then remembered, then first", () => {
    const asking = [...list.slice(0, 3), browser("d", { handoff: { reason: "x", requested_at: 1 } })];
    expect(pickBrowserToOpen(asking, "a", "t2")).toBe("d");
    expect(pickBrowserToOpen(list, "a", "t2")).toBe("b");
    expect(pickBrowserToOpen(list, "c", "t2")).toBe("c");
    expect(pickBrowserToOpen(list, "d", "t-none")).toBe("d");
    expect(pickBrowserToOpen(list, "d", null)).toBe("d");
    expect(pickBrowserToOpen(list, "gone", null)).toBe("a");
  });
  it("does not move an existing selection when the focused terminal changes", () => {
    expect(pickSelectedBrowserId(list, "a", null, "t2")).toBe("a");
  });
  it("when the shown tab is gone: asking, then the active terminal's, then first", () => {
    expect(pickSelectedBrowserId(list, "gone", null, "t2")).toBe("b");
    expect(pickSelectedBrowserId(list, "gone", null, null)).toBe("a");
    const asking = [...list.slice(0, 3), browser("d", { handoff: { reason: "x", requested_at: 1 } })];
    expect(pickSelectedBrowserId(asking, "gone", null, "t2")).toBe("d");
  });
  it("still waits for a tab just opened", () => {
    expect(pickSelectedBrowserId(list, "new", "new", "t2")).toBeNull();
  });
});
