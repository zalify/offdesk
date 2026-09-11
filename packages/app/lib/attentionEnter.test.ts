import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendAttentionEnter } from "./attentionEnter";
import { openSocket } from "./secureTransport";
import { terminalWsUrl } from "./api";

vi.mock("./secureTransport", () => ({ openSocket: vi.fn() }));
vi.mock("./api", () => ({ terminalWsUrl: vi.fn(() => "wss://hub/ws/terminal/remote/waiting") }));

function socket() {
  return { onmessage: null, onerror: null, onclose: null, binaryType: "blob", bufferedAmount: 0,
    send: vi.fn(), close: vi.fn() } as unknown as WebSocket;
}
let ws: WebSocket;
const options = (overrides = {}) => ({ machineId: "remote", terminalId: "waiting", deviceId: "phone",
  isAllowed: () => true, signal: new AbortController().signal, ...overrides });
const output = () => ws.onmessage?.({ data: new ArrayBuffer(1) } as MessageEvent);

beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); ws = socket(); vi.mocked(openSocket).mockReturnValue(ws); });
afterEach(() => { vi.useRealTimers(); });

describe("background attention Enter", () => {
  it("uses the target and secure transport; waits for attach output and sends exactly one Enter without resizing", async () => {
    const done = sendAttentionEnter(options());
    expect(terminalWsUrl).toHaveBeenCalledWith("remote", "waiting", "phone");
    expect(openSocket).toHaveBeenCalledWith("wss://hub/ws/terminal/remote/waiting");
    expect(ws.send).not.toHaveBeenCalled();
    ws.onmessage?.({ data: JSON.stringify({ type: "compression_enabled" }) } as MessageEvent);
    expect(ws.send).not.toHaveBeenCalled();
    output(); output();
    expect(ws.send).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ type: "command_input", data: "\r" }));
    await vi.advanceTimersByTimeAsync(250); await done;
    expect(ws.close).toHaveBeenCalledOnce();
  });
  it("waits for native encryption's send queue before closing", async () => {
    const done = sendAttentionEnter(options());
    Object.defineProperty(ws, "bufferedAmount", { value: 1, writable: true });
    output(); await vi.advanceTimersByTimeAsync(500);
    expect(ws.close).not.toHaveBeenCalled();
    Object.defineProperty(ws, "bufferedAmount", { value: 0 });
    await vi.advanceTimersByTimeAsync(250); await done;
    expect(ws.close).toHaveBeenCalledOnce();
  });
  it("rechecks the prompt and permissions after connecting", async () => {
    let allowed = true;
    const done = sendAttentionEnter(options({ isAllowed: () => allowed }));
    const rejected = expect(done).rejects.toThrow("Request changed");
    allowed = false; output(); await rejected;
    expect(ws.send).not.toHaveBeenCalled();
  });
  it("does not open a socket for view-only, missing identity, or an already cancelled request", async () => {
    const controller = new AbortController(); controller.abort();
    for (const value of [{ isAllowed: () => false }, { deviceId: "" }, { signal: controller.signal }]) {
      await expect(sendAttentionEnter(options(value))).rejects.toThrow("no longer available");
    }
    expect(openSocket).not.toHaveBeenCalled();
  });
  it("cancels on unmount and never sends later output", async () => {
    const controller = new AbortController();
    const done = sendAttentionEnter(options({ signal: controller.signal }));
    const rejected = expect(done).rejects.toThrow("Request changed");
    controller.abort(); output(); await rejected;
    expect(ws.send).not.toHaveBeenCalled();
    expect(ws.close).toHaveBeenCalledOnce();
  });
  it("times out without retrying or sending to another terminal", async () => {
    const done = sendAttentionEnter(options());
    const rejected = expect(done).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(10_000); await rejected;
    expect(ws.send).not.toHaveBeenCalled(); expect(openSocket).toHaveBeenCalledOnce();
  });
  it("reports a connection error after sending without replaying the Enter", async () => {
    const done = sendAttentionEnter(options());
    const rejected = expect(done).rejects.toThrow("Connection lost");
    output(); ws.onerror?.({} as Event); await rejected;
    await vi.advanceTimersByTimeAsync(500);
    expect(ws.send).toHaveBeenCalledTimes(1); expect(openSocket).toHaveBeenCalledOnce();
  });
});
