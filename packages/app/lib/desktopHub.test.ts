import { describe, expect, it } from "vitest";

import { baseUrlFor, codeFromLink, hubAddressOptions, hubIsReady, portOf, tokenFromLink } from "./desktopHub";

describe("phone addresses", () => {
  it("retains HTTPS and the tunnel port when switching back from LAN", () => {
    const publicUrl = "https://hub.example.com:8443";
    expect(hubAddressOptions({
      url: "http://192.168.1.2:4317", public_url: publicUrl,
      local_url: "http://127.0.0.1:4317", link: null, short: null,
      candidates: [{ interface: "en0", address: "192.168.1.2" }],
    })).toEqual([
      { url: publicUrl, label: "Internet" },
      { url: "http://192.168.1.2:4317", label: "en0" },
    ]);
  });

  it("brackets IPv6 LAN addresses", () => {
    expect(baseUrlFor("fd00::2", "4317")).toBe("http://[fd00::2]:4317");
  });
});

describe("the sign-in link", () => {
  it("gives up its token", () => {
    expect(tokenFromLink("http://192.168.1.10:4317/?token=abc.def")).toBe("abc.def");
  });

  it("is null without one, and on junk", () => {
    expect(tokenFromLink("http://192.168.1.10:4317/")).toBeNull();
    expect(tokenFromLink(null)).toBeNull();
    expect(tokenFromLink("not a link")).toBeNull();
  });

  it("carries a code in its short form", () => {
    expect(codeFromLink("http://192.168.1.10:4317/?code=EQRFN4H9")).toBe("EQRFN4H9");
    expect(codeFromLink("http://192.168.1.10:4317/?token=x")).toBeNull();
  });
});

describe("the hub's port", () => {
  it("is read off the address, 4317 when unstated", () => {
    expect(portOf("http://192.168.1.10:4317")).toBe("4317");
    expect(portOf("http://192.168.1.10:8080")).toBe("8080");
    expect(portOf("http://hub.local")).toBe("4317");
    expect(portOf("")).toBe("4317");
  });

  it("makes a base URL from a picked address", () => {
    expect(baseUrlFor("10.0.0.5", "4317")).toBe("http://10.0.0.5:4317");
  });
});

describe("a ready hub", () => {
  it("does not confuse installed services with a connected local machine", () => {
    const status = { supported: true, bundled: true, hub_installed: true, node_installed: true, listening: true,
      setup: { hub_running: true, machine_registered: true, node_online: true, tmux_available: true } };
    expect(hubIsReady(status)).toBe(true);
    for (const key of Object.keys(status.setup)) {
      expect(hubIsReady({ ...status, setup: { ...status.setup, [key]: false } })).toBe(false);
    }
  });
  it("has both services and answers", () => {
    const status = { supported: true, bundled: true, hub_installed: true, node_installed: true, listening: true };
    expect(hubIsReady(status)).toBe(true);
    expect(hubIsReady({ ...status, listening: false })).toBe(false);
    expect(hubIsReady({ ...status, node_installed: false })).toBe(false);
  });
});
