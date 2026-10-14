import { afterEach, describe, expect, it, vi } from "vitest";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { hubHost, hubInterfaceLabel, plainScanVerdict, probeHubVersion } from "./hubVersionCheck";
import { compareVersions, isOlder } from "./versions";

afterEach(() => invoke.mockReset());

describe("version order", () => {
  it("orders releases, pre-releases and v-prefixed tags", () => {
    expect(compareVersions("0.21.4", "0.23.0")).toBeLessThan(0);
    expect(compareVersions("0.23.0", "v0.23.0")).toBe(0);
    expect(compareVersions("0.23.10", "0.23.9")).toBeGreaterThan(0);
    expect(compareVersions("0.24.0-rc.1", "0.24.0")).toBeLessThan(0);
    expect(compareVersions("0.24.0-rc.2", "0.24.0-rc.10")).toBeLessThan(0);
  });
  it("claims nothing about things that are not versions", () => {
    expect(compareVersions("bundled", "0.23.0")).toBeNull();
    expect(isOlder("bundled", "0.23.0")).toBe(false);
  });
});

describe("plain scan before opening a hub (P01)", () => {
  it("opens a hub at or past the version this app was built with", () => {
    expect(plainScanVerdict({ hub: "0.23.0", expected: "0.23.0" })).toEqual({ kind: "open" });
    expect(plainScanVerdict({ hub: "0.24.1", expected: "0.23.0" })).toEqual({ kind: "open" });
  });
  it("stops at an older hub and says which", () => {
    expect(plainScanVerdict({ hub: "0.23.0", expected: "0.24.0" })).toEqual({ kind: "older", hub: "0.23.0", expected: "0.24.0" });
  });
  it("treats a hub without /api/version as older than 0.23", () => {
    expect(plainScanVerdict({ hub: null, expected: "0.23.0" })).toEqual({ kind: "older", hub: null, expected: "0.23.0" });
    expect(hubInterfaceLabel(null)).toBe("older than 0.23");
  });
  it("opens the hub as before when the check could not be made", () => {
    expect(plainScanVerdict(null)).toEqual({ kind: "open" });
    expect(plainScanVerdict({ hub: "dev", expected: "0.23.0" })).toEqual({ kind: "open" });
  });
  it("asks natively and turns a failure into no answer", async () => {
    invoke.mockResolvedValueOnce({ hub: "0.21.4", expected: "0.23.0" });
    await expect(probeHubVersion("http://mac-mini.local:4317/?token=x")).resolves.toEqual({ hub: "0.21.4", expected: "0.23.0" });
    expect(invoke).toHaveBeenCalledWith("probe_hub_version", { url: "http://mac-mini.local:4317/?token=x" });
    invoke.mockRejectedValueOnce("Command probe_hub_version not found");
    await expect(probeHubVersion("http://mac-mini.local:4317")).resolves.toBeNull();
  });
  it("names the hub by its host", () => {
    expect(hubHost("http://mac-mini.local:4317/?token=abc")).toBe("mac-mini.local");
    expect(hubHost("192.168.1.4:4317")).toBe("192.168.1.4");
  });
});
