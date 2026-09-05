import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ invoke: vi.fn(), channels: [] as { onmessage: (message: unknown) => void }[], tauri: true }));
vi.mock("./platform", () => ({ isTauri: () => mock.tauri, isBundledOrigin: () => true }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mock.invoke, Channel: class { onmessage = (_message: unknown) => {}; constructor() { mock.channels.push(this); } } }));
const paired = { endpoint: { hub_url: "https://paired.example", public_key: "pinned" }, device_id: "phone" };
const tick = () => new Promise(resolve => setTimeout(resolve,0));
beforeEach(() => {
  vi.resetModules(); mock.invoke.mockReset(); mock.channels.length = 0; mock.tauri = true;
  vi.stubGlobal("navigator", { userAgent: "iPhone" });
  vi.stubGlobal("localStorage", { removeItem: vi.fn() });
  vi.stubGlobal("CloseEvent", class extends Event { code: number; constructor(type: string, init: { code: number }) { super(type); this.code = init.code; } });
  vi.stubGlobal("WebSocket", vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

describe("encrypted native transport", () => {
  it("does not restore a forgotten Hub from a delayed discovery response", async () => {
    let resolveDiscovery: (value: unknown) => void = () => {};
    mock.invoke.mockImplementation(command => command === "secure_status" ? Promise.resolve(paired) : command === "secure_routes" ? new Promise(resolve => { resolveDiscovery = resolve; }) : Promise.resolve());
    const transport = await import("./secureTransport");
    await transport.restoreSecureConnection();
    const pending = transport.refreshConnectionRoutes();
    await tick();
    await transport.forgetSecureConnection();
    resolveDiscovery({ status: paired, routes: [], discovery_available: true });
    await expect(pending).rejects.toThrow("paired Hub changed");
    expect(transport.secureConnectionStatus()).toBeNull();
    expect(transport.isSecureConnection()).toBe(false);
  });
  it("switches routes without re-pairing and accepts reconnect callbacks with the original URL", async () => {
    const remote = { ...paired, endpoint: { ...paired.endpoint, hub_url: "http://192.168.1.2:4317" } };
    mock.invoke.mockImplementation(async command => command === "secure_status" ? paired : command === "secure_switch_route" ? remote : undefined);
    const transport = await import("./secureTransport");
    await transport.restoreSecureConnection();
    await transport.switchConnectionRoute(remote.endpoint.hub_url);
    expect(transport.secureConnectionStatus()?.device_id).toBe("phone");
    transport.openSocket("wss://paired.example/ws/events");
    await tick();
    expect(mock.invoke.mock.calls.some(([c]) => c === "secure_socket_open")).toBe(true);
    expect(mock.invoke.mock.calls.some(([c]) => c === "secure_pair" || c === "secure_forget")).toBe(false);
    expect(WebSocket).not.toHaveBeenCalled();
    mock.invoke.mockRejectedValue(new Error("Hub identity changed"));
    await expect(transport.switchConnectionRoute("https://wrong.example")).rejects.toThrow("identity changed");
    expect(transport.secureConnectionStatus()).toEqual(remote);
  });

  it("blocks a switch while a paste is waiting to cross native IPC", async () => {
    let release: () => void = () => {};
    mock.invoke.mockImplementation(command => command === "secure_status" ? Promise.resolve(paired) : command === "secure_socket_send" ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve());
    const transport = await import("./secureTransport");
    await transport.restoreSecureConnection();
    const socket = transport.openSocket("wss://paired.example/ws/events");
    await tick();
    const id = mock.invoke.mock.calls.find(([c]) => c === "secure_socket_open")![1].id;
    mock.channels[0].onmessage({ type: "opened", id });
    socket.send("a long paste");
    await tick();
    await expect(transport.switchConnectionRoute("http://192.168.1.2:4317")).rejects.toThrow("Finish sending");
    expect(mock.invoke.mock.calls.some(([c]) => c === "secure_switch_route")).toBe(false);
    release(); await tick();
    expect(socket.bufferedAmount).toBe(0);
  });
  it("sends API bodies only through native IPC and never downgrades on failure", async () => {
    mock.invoke.mockImplementation(async (command) => command === "secure_status" ? paired : { type: "http", id: "request", status: 200, body: '{"ok":true}' });
    const transport = await import("./secureTransport");
    await transport.restoreSecureConnection();
    const result = await transport.secureFetch("POST", "/api/terminals", '{"private":"text"}');
    expect(await result.json()).toEqual({ ok: true });
    expect(mock.invoke).toHaveBeenLastCalledWith("secure_request", { method: "POST", path: "/api/terminals", body: '{"private":"text"}' });
    mock.invoke.mockRejectedValue(new Error("Pinned Hub identity changed"));
    await expect(transport.secureFetch("GET", "/api/auth/me")).rejects.toThrow("identity changed");
    expect(transport.isSecureConnection()).toBe(true);
    expect(WebSocket).not.toHaveBeenCalled();
  });
  it("a damaged saved connection stays encrypted and requires explicit recovery", async () => {
    mock.invoke.mockRejectedValue(new Error("Damaged connection"));
    const transport = await import("./secureTransport");
    await expect(transport.restoreSecureConnection()).rejects.toThrow("Damaged");
    expect(transport.isSecureConnection()).toBe(true);
    const socket = transport.openSocket("wss://paired.example/ws/events");
    const closed = vi.fn(); socket.onclose = closed;
    await tick();
    expect(closed).toHaveBeenCalledOnce();
    expect(WebSocket).not.toHaveBeenCalled();
  });
  it("preserves paste/Enter ordering and binary bytes on private IPC channels", async () => {
    mock.invoke.mockImplementation(async (command) => command === "secure_status" ? paired : undefined);
    const transport = await import("./secureTransport");
    await transport.restoreSecureConnection();
    const socket = transport.openSocket("wss://paired.example/ws/events?token=unused&device_id=phone");
    socket.binaryType = "arraybuffer";
    await tick();
    const opening = mock.invoke.mock.calls.find(([command]) => command === "secure_socket_open")![1];
    expect(opening.path).toBe("/ws/events?device_id=phone");
    const id = opening.id;
    mock.channels[0].onmessage({ type: "opened", id });
    socket.send(new Blob([new Uint8Array([0, 255, 13])]));
    socket.send("\r");
    await tick(); await tick();
    const sent = mock.invoke.mock.calls.filter(([command]) => command === "secure_socket_send");
    expect(sent.map(([, args]) => [args.binary, args.data])).toEqual([[true, "AP8N"], [false, "\r"]]);
    expect(socket.bufferedAmount).toBe(0);
    const messages = vi.fn(); socket.onmessage = messages;
    mock.channels[0].onmessage({ type: "binary", id, data: "AP8N" });
    expect(new Uint8Array(messages.mock.calls[0][0].data)).toEqual(new Uint8Array([0,255,13]));
    mock.channels[0].onmessage({ type: "closed", id });
    expect(socket.readyState).toBe(3);
    expect(() => socket.send("repeat")).toThrow();
  });
  it("rejects a different socket origin instead of sending plaintext there", async () => {
    mock.invoke.mockResolvedValue(paired);
    const transport = await import("./secureTransport");
    await transport.restoreSecureConnection();
    transport.openSocket("wss://other.example/ws/events");
    await tick();
    expect(mock.invoke.mock.calls.some(([command]) => command === "secure_socket_open")).toBe(false);
    expect(WebSocket).not.toHaveBeenCalled();
  });
  it("ordinary browser connections keep their existing transport", async () => {
    mock.tauri = false;
    const transport = await import("./secureTransport");
    expect(await transport.restoreSecureConnection()).toBeNull();
    transport.openSocket("ws://localhost/ws/events");
    expect(WebSocket).toHaveBeenCalledWith("ws://localhost/ws/events");
    expect(mock.invoke).not.toHaveBeenCalled();
  });
  it("cancels an HTTP wait without resending a potentially executed mutation", async () => {
    mock.invoke.mockImplementation((command) => command === "secure_status" ? Promise.resolve(paired) : new Promise(() => {}));
    const transport = await import("./secureTransport"); await transport.restoreSecureConnection();
    const controller = new AbortController();
    const pending = transport.secureFetch("POST", "/api/terminals", "{}", controller.signal);
    await tick(); controller.abort();
    await expect(pending).rejects.toThrow("Aborted");
    expect(mock.invoke.mock.calls.filter(([c]) => c === "secure_request")).toHaveLength(1);
  });
});
