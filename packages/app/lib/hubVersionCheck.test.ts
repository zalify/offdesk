import { afterEach, describe, expect, it, vi } from "vitest";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { hubHost, hubInterfaceLabel, plainScanVerdict, probeHubVersion, targetHubVersion } from "./hubVersionCheck";
import { compareMinor, compareVersions } from "./versions";

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
    expect(compareMinor("bundled", "0.23.0")).toBeNull();
  });
  it("can compare by major.minor alone", () => {
    expect(compareMinor("0.23.0", "0.23.9")).toBe(0);
    expect(compareMinor("0.22.9", "0.23.0")).toBeLessThan(0);
    expect(compareMinor("1.0.0", "0.99.0")).toBeGreaterThan(0);
  });
});

describe("plain scan before opening a hub (P01)", () => {
  it("opens a hub at or past the version this app was built with", () => {
    expect(plainScanVerdict({ hub: "0.23.0", expected: "0.23.0" })).toEqual({ kind: "open" });
    expect(plainScanVerdict({ hub: "0.24.1", expected: "0.23.0" })).toEqual({ kind: "open" });
  });
  it("stops at a hub a minor version behind and says which", () => {
    expect(plainScanVerdict({ hub: "0.23.0", expected: "0.24.0" })).toEqual({ kind: "older", hub: "0.23.0", target: "0.24.0" });
  });
  it("lets a hub one patch behind through", () => {
    expect(plainScanVerdict({ hub: "0.23.0", expected: "0.23.1" })).toEqual({ kind: "open" });
  });
  it("never asks for a hub version that isn't released", () => {
    expect(plainScanVerdict({ hub: "0.22.0", latest: "0.23.0", expected: "0.24.0" })).toEqual({ kind: "older", hub: "0.22.0", target: "0.23.0" });
    expect(plainScanVerdict({ hub: "0.23.0", latest: "0.23.0", expected: "0.24.0" })).toEqual({ kind: "open" });
    // Before the hub has looked the newest release up: the build's version.
    expect(plainScanVerdict({ hub: "0.22.0", latest: null, expected: "0.24.0" })).toEqual({ kind: "older", hub: "0.22.0", target: "0.24.0" });
    expect(targetHubVersion("0.24.0", "0.25.0")).toBe("0.24.0");
    expect(targetHubVersion("0.24.0", "nightly")).toBe("0.24.0");
  });
  it("treats a hub without /api/version as older only once the app expects one with it", () => {
    // Built at 0.22: every live 0.22 hub answers 404 and must not get P01.
    expect(plainScanVerdict({ hub: null, expected: "0.22.0" })).toEqual({ kind: "open" });
    expect(plainScanVerdict({ hub: null, expected: "0.23.0" })).toEqual({ kind: "older", hub: null, target: "0.23.0" });
    expect(hubInterfaceLabel(null)).toBe("older than 0.23");
  });
  it("never shows the notice when the build could not read its hub version", () => {
    // build.rs falls back to 0.0.0.
    expect(plainScanVerdict({ hub: null, expected: "0.0.0" })).toEqual({ kind: "open" });
    expect(plainScanVerdict({ hub: "0.21.4", expected: "0.0.0" })).toEqual({ kind: "open" });
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
