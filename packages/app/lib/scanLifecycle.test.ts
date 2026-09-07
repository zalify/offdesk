import { expect, it, vi } from "vitest";
import { scanWithCleanup } from "./scanLifecycle";
import { isLocalHubAddress } from "./onboardingFlow";

it("waits for camera cleanup before allowing a scanned link to navigate", async () => {
  let finish!: () => void;
  const cleanup = new Promise<void>(resolve => { finish = resolve; });
  const navigate = vi.fn();
  const cancel = vi.fn(() => cleanup);
  const operation = scanWithCleanup(async () => "scanned-link", cancel).then(navigate);
  await Promise.resolve();
  expect(cancel).toHaveBeenCalledOnce();
  expect(navigate).not.toHaveBeenCalled();
  finish();
  await operation;
  expect(navigate).toHaveBeenCalledWith("scanned-link");
});
it("cleans up failed scans and blocks navigation if cleanup fails", async () => {
  const cancel = vi.fn(async () => {});
  await expect(scanWithCleanup(async () => { throw new Error("cancelled"); }, cancel)).rejects.toThrow("cancelled");
  expect(cancel).toHaveBeenCalledOnce();
  await expect(scanWithCleanup(async () => "link", async () => { throw new Error("camera cleanup failed"); })).rejects.toThrow("camera cleanup failed");
});
it("never offers local machine repair for a remote or invalid hub address", () => {
  for (const url of ["http://127.0.0.1:4317", "http://localhost:4317", "http://[::1]:4317"]) expect(isLocalHubAddress(url)).toBe(true);
  for (const url of ["", "file:///tmp/hub", "http://localhost.example.com", "https://hub.example.com", "http://192.168.1.1:4317"]) expect(isLocalHubAddress(url)).toBe(false);
});
