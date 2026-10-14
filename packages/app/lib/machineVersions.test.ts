import { describe, expect, it } from "vitest";
import { ApiError, type MachineVersionInfo } from "./api";
import { anyNodeBehind, loadSheetVersions, nodeUpdateChip, nodeVersionLabel } from "./machineVersions";

const hub = { hub: "0.23.0", latest: "0.24.0", update_available: true };
const mini: MachineVersionInfo = { id: "m1", name: "mac-mini", version: "0.23.0", update_available: true };
const pro: MachineVersionInfo = { id: "m2", name: "macbook-pro", version: null, update_available: true };
const current: MachineVersionInfo = { id: "m3", name: "nas", version: "0.24.0", update_available: false };

describe("machine versions in the phone sheet (P03)", () => {
  it("labels each node by what it reports", () => {
    expect(nodeVersionLabel(mini)).toBe("node 0.23.0");
    expect(nodeVersionLabel(pro)).toBe("node older than 0.23");
    // Offline nodes are not listed by the hub: nothing is said about them.
    expect(nodeVersionLabel(undefined)).toBeNull();
  });
  it("shows the newest release on nodes that are behind it", () => {
    expect(nodeUpdateChip(mini, "0.24.0")).toBe("↑ 0.24.0");
    expect(nodeUpdateChip(pro, "0.24.0")).toBe("↑ 0.24.0");
    expect(nodeUpdateChip(current, "0.24.0")).toBeNull();
    expect(nodeUpdateChip(mini, null)).toBeNull();
  });
  it("offers the update command only when some node is behind", async () => {
    const behind = await loadSheetVersions(async () => hub, async () => [mini, current]);
    expect(anyNodeBehind(behind)).toBe(true);
    const fine = await loadSheetVersions(async () => hub, async () => [current]);
    expect(anyNodeBehind(fine)).toBe(false);
    expect(anyNodeBehind(null)).toBe(false);
  });
  it("keys nodes by machine id", async () => {
    const versions = await loadSheetVersions(async () => hub, async () => [mini, pro]);
    expect(versions?.machines.m2).toEqual(pro);
    expect(versions?.hub.hub).toBe("0.23.0");
  });
  it("shows nothing for a hub from before 0.23, and raises nothing", async () => {
    await expect(loadSheetVersions(async () => { throw new ApiError(404, ""); }, async () => { throw new ApiError(405, ""); })).resolves.toBeNull();
    await expect(loadSheetVersions(async () => hub, async () => { throw new ApiError(405, ""); })).resolves.toBeNull();
    // A hub whose SPA answered instead of the API.
    await expect(loadSheetVersions(async () => "<!doctype html>" as never, async () => [])).resolves.toBeNull();
  });
});
