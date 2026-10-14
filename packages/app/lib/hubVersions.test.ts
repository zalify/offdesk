import { describe, expect, it } from "vitest";

import { ApiError } from "./api";
import { checkedAgo, hostOf, hubBehind, hubWarning, isOlderHub, partsBehind, type HubAnswer } from "./hubVersions";

const known = (hub: string, latest: string | null): HubAnswer => ({
  kind: "known",
  version: { hub, latest, update_available: latest !== null && latest !== hub },
});

describe("a hub's version", () => {
  it("is older than 0.23 when the endpoint is missing, not an error", () => {
    expect(isOlderHub(new ApiError(404, "not found"))).toBe(true);
    expect(isOlderHub(new ApiError(405, "method not allowed"))).toBe(true);
    expect(isOlderHub(new ApiError(500, "boom"))).toBe(false);
    expect(isOlderHub(new TypeError("Failed to fetch"))).toBe(false);
  });

  it("is behind when older or when a newer release is out", () => {
    expect(hubBehind({ kind: "older" })).toBe(true);
    expect(hubBehind(known("0.23.0", "0.24.0"))).toBe(true);
    expect(hubBehind(known("0.23.0", "0.23.0"))).toBe(false);
    expect(hubBehind(known("0.23.0", null))).toBe(false);
    expect(hubBehind({ kind: "unknown" })).toBe(false);
    expect(hubBehind(null)).toBe(false);
  });
});

describe("parts behind", () => {
  const nodes = [
    { id: "a", name: "mac-mini", version: "0.23.0", update_available: true },
    { id: "b", name: "macbook-pro", version: null, update_available: true },
    { id: "c", name: "nas", version: "0.24.0", update_available: false },
  ];

  it("counts the app, the hub and each node, but not the interface twice", () => {
    expect(partsBehind("0.9.1", known("0.23.0", "0.24.0"), nodes)).toBe(4);
    expect(partsBehind(null, known("0.24.0", "0.24.0"), nodes)).toBe(2);
    expect(partsBehind(null, { kind: "older" }, null)).toBe(1);
    expect(partsBehind(null, null, null)).toBe(0);
  });
});

describe("the warning on a node's phone panel", () => {
  it("names the hub and what is out, or that it predates version reporting", () => {
    expect(hubWarning(known("0.23.0", "0.24.0"), "mac-mini")).toBe("mac-mini's hub is 0.23.0, 0.24.0 is out");
    expect(hubWarning({ kind: "older" }, "mac-mini")).toBe("mac-mini's hub is older than 0.23");
  });

  it("stays away when the hub is current or can't be asked", () => {
    expect(hubWarning(known("0.24.0", "0.24.0"), "mac-mini")).toBeNull();
    expect(hubWarning(known("0.24.0", null), "mac-mini")).toBeNull();
    expect(hubWarning({ kind: "unknown" }, "mac-mini")).toBeNull();
    expect(hubWarning(null, "mac-mini")).toBeNull();
  });
});

describe("small words", () => {
  it("says how long ago the hub was asked", () => {
    expect(checkedAgo(0, 30_000)).toBe("just now");
    expect(checkedAgo(0, 60_000)).toBe("1 minute ago");
    expect(checkedAgo(0, 2 * 60_000)).toBe("2 minutes ago");
    expect(checkedAgo(0, 3 * 3_600_000)).toBe("3 hours ago");
  });

  it("names a hub by its host", () => {
    expect(hostOf("http://192.168.1.190:4317")).toBe("192.168.1.190");
    expect(hostOf("https://mac-mini.tail1234.ts.net")).toBe("mac-mini.tail1234.ts.net");
    expect(hostOf("http://[fd00::2]:4317")).toBe("fd00::2");
    expect(hostOf("not a url")).toBe("not a url");
  });
});
