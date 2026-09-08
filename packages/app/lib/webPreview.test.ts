import { describe, expect, it } from "vitest";
import { launcherUrl, parseLocalPreview } from "./webPreview";

describe("local preview links", () => {
  it("preserves paths, queries and fragments and selects the loopback family", () => {
    expect(parseLocalPreview("http://localhost:3127/customization/test?x=1#part")).toEqual({ port: 3127, address_family: "ipv4", target: "/customization/test?x=1#part" });
    expect(parseLocalPreview("http://[::1]:5173/")?.address_family).toBe("ipv6");
    expect(parseLocalPreview("http://0.0.0.0:3000/")?.port).toBe(3000);
  });
  it("does not turn other addresses or ambiguous authorities into node requests", () => {
    for (const value of ["http://localhost.evil:3127/", "http://localhost@evil:3127/", "https://localhost:3127/", "http://192.168.1.1:3127/", "http://127.1:3127/", "http://localhost:0/", "http://localhost:99999/", "javascript:alert(1)"]) expect(parseLocalPreview(value)).toBeNull();
  });
  it("opens a trusted Hub launcher with encoded target parameters, no credentials", () => {
    const url = new URL(launcherUrl("https://hub.example.test", "machine", "terminal", { port: 3127, address_family: "ipv4", target: "/page?x=1#part" }));
    expect(url.origin).toBe("https://hub.example.test");
    expect(url.pathname).toBe("/__offdesk_preview__/launch");
    expect(url.searchParams.get("target")).toBe("/page?x=1#part");
    expect(url.searchParams.has("token")).toBe(false);
  });
});
