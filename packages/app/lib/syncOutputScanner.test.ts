import { describe, expect, it } from "vitest";
import { scanSyncUpdateMarkers } from "./syncOutputScanner";

const enc = (s: string) => new TextEncoder().encode(s);

describe("scanSyncUpdateMarkers", () => {
  it("tracks BSU and ESU within a single chunk", () => {
    const r1 = scanSyncUpdateMarkers(new Uint8Array(0), enc("\x1b[?2026hhello"), false);
    expect(r1.inSync).toBe(true);
    const r2 = scanSyncUpdateMarkers(r1.nextTail, enc(" world\x1b[?2026l"), r1.inSync);
    expect(r2.inSync).toBe(false);
  });

  it("handles BSU/ESU split across chunk boundaries", () => {
    const r1 = scanSyncUpdateMarkers(new Uint8Array(0), enc("abc\x1b[?20"), false);
    expect(r1.inSync).toBe(false);
    const r2 = scanSyncUpdateMarkers(r1.nextTail, enc("26hpayload\x1b[?202"), r1.inSync);
    expect(r2.inSync).toBe(true);
    const r3 = scanSyncUpdateMarkers(r2.nextTail, enc("6l"), r2.inSync);
    expect(r3.inSync).toBe(false);
  });

  it("ends false when BSU and ESU both appear in the same chunk", () => {
    const r = scanSyncUpdateMarkers(
      new Uint8Array(0),
      enc("\x1b[?2026h\x1b[2Jhello\x1b[?2026l"),
      false,
    );
    expect(r.inSync).toBe(false);
  });
});
