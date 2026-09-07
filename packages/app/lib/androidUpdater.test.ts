import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

beforeEach(() => { vi.resetModules(); invoke.mockReset(); });
afterEach(() => vi.restoreAllMocks());
describe("Android updater", () => {
  it("checks the native official feed and surfaces the available version", async () => {
    const updater = await import("./androidUpdater");
    invoke.mockResolvedValue({ version: "0.6.3" });
    await updater.checkAndroidUpdate(true);
    expect(invoke).toHaveBeenCalledWith("plugin:offdesk-android-updater|check");
    expect(updater.getAndroidUpdateState()).toMatchObject({ version: "0.6.3", busy: null, error: null });
  });
  it("silences startup network failures but reports a failed manual check", async () => {
    const updater = await import("./androidUpdater");
    invoke.mockRejectedValue(new Error("offline"));
    await updater.checkAndroidUpdate(true);
    expect(updater.getAndroidUpdateState().error).toBeNull();
    await updater.checkAndroidUpdate();
    expect(updater.getAndroidUpdateState().error).toContain("offline");
  });
  it("keeps the update retryable after Android install permission is requested", async () => {
    const updater = await import("./androidUpdater");
    invoke.mockResolvedValueOnce({ version: "0.6.3" }).mockResolvedValueOnce({ status: "permission-required" }).mockResolvedValueOnce({ status: "installer-opened" });
    await updater.checkAndroidUpdate();
    await updater.installAndroidUpdate();
    expect(updater.getAndroidUpdateState()).toMatchObject({ version: "0.6.3", busy: null });
    expect(updater.getAndroidUpdateState().message).toContain("Allow Offdesk");
    await updater.installAndroidUpdate();
    expect(updater.getAndroidUpdateState().message).toContain("Android installer");
  });
  it("throttles automatic checks but allows manual checks and a later foreground check", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const updater = await import("./androidUpdater");
    invoke.mockResolvedValue({ version: null });
    await updater.checkAndroidUpdate(true);
    await updater.checkAndroidUpdate(true);
    expect(invoke).toHaveBeenCalledTimes(1);
    await updater.checkAndroidUpdate();
    expect(invoke).toHaveBeenCalledTimes(2);
    now.mockReturnValue(1_800_000_000_000 + 6 * 60 * 60 * 1000 + 1);
    await updater.checkAndroidUpdate(true);
    expect(invoke).toHaveBeenCalledTimes(3);
  });
  it("prevents concurrent checks and installs from the toast and settings", async () => {
    const updater = await import("./androidUpdater");
    let finish!: (value: { version: null }) => void;
    invoke.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const pending = updater.checkAndroidUpdate();
    await updater.checkAndroidUpdate();
    await updater.installAndroidUpdate();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    finish({ version: null });
    await pending;
    expect(updater.getAndroidUpdateState().message).toContain("up to date");
  });
});
