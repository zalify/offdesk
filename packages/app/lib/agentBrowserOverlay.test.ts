import { describe, expect, it } from "vitest";
import type { AgentBrowserInfo } from "@offdesk/shared";
import {
  browserControlledBy,
  browserLabel,
  browserNeedsPerson,
  dialogText,
  findNewHandoffs,
  findNewReclaims,
  followPopups,
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
