import { beforeEach, describe, expect, it } from "vitest";
import type { ResourceStats } from "@offdesk/shared";
import {
  deleteLiveMachineStat,
  getLiveMachineStats,
  getLiveMachineStatsPresence,
  getLiveRttMs,
  recordLiveRttSample,
  resetLiveRttMs,
  setLiveMachineStat,
  setLiveMachineStatsSnapshot,
  subscribeLiveMachineStats,
  subscribeLiveMachineStatsPresence,
  subscribeLiveRtt,
} from "./liveMetricsStore";

function makeStats(cpu: number): ResourceStats {
  return {
    cpu_percent: cpu,
    memory_used: 1024,
    memory_total: 4096,
    disks: [],
  };
}

describe("liveMetricsStore", () => {
  beforeEach(() => {
    resetLiveRttMs();
    setLiveMachineStatsSnapshot({});
  });

  it("rounds RTT EWMA to integer ms and suppresses unchanged integer notifications", () => {
    let calls = 0;
    const unsub = subscribeLiveRtt(() => {
      calls += 1;
    });

    recordLiveRttSample(42.1);
    expect(getLiveRttMs()).toBe(42);
    expect(calls).toBe(1);

    // Sub-ms EWMA drift still rounds to 42 -> no notification
    recordLiveRttSample(42.3);
    expect(getLiveRttMs()).toBe(42);
    expect(calls).toBe(1);

    // Larger jump changes rounded integer -> notifies
    recordLiveRttSample(50);
    expect(getLiveRttMs()).toBe(45);
    expect(calls).toBe(2);

    unsub();
  });

  it("notifies presence subscribers only on machine online/offline transitions, not stat ticks", () => {
    let statsCalls = 0;
    let presenceCalls = 0;
    const unsubStats = subscribeLiveMachineStats(() => {
      statsCalls += 1;
    });
    const unsubPresence = subscribeLiveMachineStatsPresence(() => {
      presenceCalls += 1;
    });

    setLiveMachineStat("m1", makeStats(10));
    expect(statsCalls).toBe(1);
    expect(presenceCalls).toBe(1);
    expect(getLiveMachineStatsPresence()).toEqual({ m1: true });

    // Periodic CPU tick for already-online machine: stats notifies, presence does NOT
    setLiveMachineStat("m1", makeStats(25));
    expect(statsCalls).toBe(2);
    expect(presenceCalls).toBe(1);
    expect(getLiveMachineStats().m1.cpu_percent).toBe(25);

    // Offline removes machine and notifies presence once
    deleteLiveMachineStat("m1");
    expect(statsCalls).toBe(3);
    expect(presenceCalls).toBe(2);
    expect(getLiveMachineStatsPresence()).toEqual({});

    // Deleting already-absent machine is a no-op
    deleteLiveMachineStat("m1");
    expect(statsCalls).toBe(3);
    expect(presenceCalls).toBe(2);

    unsubStats();
    unsubPresence();
  });
});
