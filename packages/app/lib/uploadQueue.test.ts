import { describe, expect, it, vi } from "vitest";
import { RemoteFileError } from "./api";
import { etaSeconds, formatEta, SpeedMeter, speedOver, UploadQueue } from "./uploadQueue";
import type { ConflictAnswer, QueueDeps, QueueItem, QueueResult } from "./uploadQueue";

const file = (name: string, size = 100) => ({ name, size });
const items = (...names: string[]): QueueItem[] => names.map((n) => ({ file: file(n), destDir: "/d" }));
const tick = () => new Promise((r) => setTimeout(r, 0));

interface Job {
  name: string;
  policy: string;
  signal: AbortSignal;
  progress: (n: number) => void;
  finish: () => void;
  fail: (err: unknown) => void;
}

/** A queue whose uploads wait until the test finishes them. */
function harness(over: Partial<QueueDeps<{ name: string; size: number }>> = {}) {
  const jobs: Job[] = [];
  const done: string[] = [];
  const drains: QueueResult[] = [];
  const queue = new UploadQueue({
    run: (item, ctx) =>
      new Promise((resolve, reject) => {
        const job: Job = {
          name: item.file.name,
          policy: ctx.policy,
          signal: ctx.signal,
          progress: ctx.onProgress,
          finish: () => resolve({ path: `${item.destDir}/${item.file.name}`, size: item.file.size }),
          fail: reject,
        };
        ctx.signal.addEventListener("abort", () => {
          const e = new Error("Aborted");
          e.name = "AbortError";
          reject(e);
        });
        jobs.push(job);
      }),
    askConflict: async () => ({ choice: "keep_both", all: false }),
    onFileDone: (p) => done.push(p),
    onDrain: (r) => drains.push(r),
    ...over,
  });
  const running = () => jobs.filter((j) => !j.signal.aborted).map((j) => j.name);
  return { queue, jobs, done, drains, running };
}

describe("UploadQueue concurrency", () => {
  it("runs two files at a time and starts the next as one finishes", async () => {
    const h = harness();
    h.queue.add(items("a", "b", "c", "d"));
    expect(h.jobs.map((j) => j.name)).toEqual(["a", "b"]);
    h.jobs[0].finish();
    await tick();
    expect(h.jobs.map((j) => j.name)).toEqual(["a", "b", "c"]);
    h.jobs[1].finish();
    h.jobs[2].finish();
    await tick();
    expect(h.jobs.map((j) => j.name)).toEqual(["a", "b", "c", "d"]);
    h.jobs[3].finish();
    await tick();
    expect(h.done).toEqual(["/d/a", "/d/b", "/d/c", "/d/d"]);
    expect(h.drains).toHaveLength(1);
    expect(h.drains[0]).toMatchObject({ error: null, cancelled: false });
    expect(h.drains[0].uploaded).toHaveLength(4);
  });

  it("never reports a snapshot after draining", async () => {
    const changes: number[] = [];
    let drained = false;
    let afterDrain = 0;
    const h = harness({
      onChange: (s) => {
        changes.push(s.filesDone);
        if (drained) afterDrain++;
      },
      onDrain: () => {
        drained = true;
      },
    });
    h.queue.add(items("a"));
    h.jobs[0].finish();
    await tick();
    expect(drained).toBe(true);
    expect(afterDrain).toBe(0);
  });

  it("appends files added while running, each with its own destDir", async () => {
    const h = harness();
    h.queue.add([{ file: file("a"), destDir: "/x" }]);
    h.queue.add([{ file: file("b"), destDir: "/y" }, { file: file("c"), destDir: "/z" }]);
    expect(h.jobs.map((j) => j.name)).toEqual(["a", "b"]);
    h.jobs.forEach((j) => j.finish());
    await tick();
    h.jobs[2].finish();
    await tick();
    expect(h.done).toEqual(["/x/a", "/y/b", "/z/c"]);
    expect(h.drains).toHaveLength(1);
    expect(h.queue.snapshot().filesTotal).toBe(3);
  });

  it("starts a fresh batch after draining", async () => {
    const h = harness();
    h.queue.add(items("a"));
    h.jobs[0].finish();
    await tick();
    h.queue.add(items("b"));
    expect(h.queue.snapshot()).toMatchObject({ filesTotal: 1, filesDone: 0 });
    h.jobs[1].finish();
    await tick();
    expect(h.drains).toHaveLength(2);
  });

  it("tracks overall bytes across running and finished files", async () => {
    const h = harness();
    h.queue.add([{ file: file("a", 100), destDir: "/d" }, { file: file("b", 300), destDir: "/d" }]);
    h.jobs[0].progress(40);
    h.jobs[1].progress(100);
    expect(h.queue.snapshot()).toMatchObject({ bytesDone: 140, bytesTotal: 400, filesDone: 0 });
    h.jobs[0].finish();
    await tick();
    expect(h.queue.snapshot()).toMatchObject({ bytesDone: 200, filesDone: 1 });
  });
});

describe("UploadQueue failures and cancel", () => {
  it("an error stops the queue and is reported once", async () => {
    const h = harness();
    h.queue.add(items("a", "b", "c"));
    const boom = new RemoteFileError(507, "no_space", "full");
    h.jobs[0].fail(boom);
    await tick();
    expect(h.jobs[1].signal.aborted).toBe(true);
    await tick();
    expect(h.jobs).toHaveLength(2);
    expect(h.drains).toHaveLength(1);
    expect(h.drains[0].error).toBe(boom);
  });

  it("cancel aborts running files and drops the queue", async () => {
    const h = harness();
    h.queue.add(items("a", "b", "c"));
    h.jobs[0].finish();
    await tick();
    h.queue.cancel();
    await tick();
    expect(h.jobs[1].signal.aborted).toBe(true);
    expect(h.jobs).toHaveLength(3);
    expect(h.drains).toHaveLength(1);
    expect(h.drains[0]).toMatchObject({ cancelled: true, error: null, uploaded: ["/d/a"] });
    expect(h.queue.active).toBe(false);
  });
});

describe("UploadQueue conflicts", () => {
  const exists = () => new RemoteFileError(409, "exists", "exists", undefined, "/d/a");

  it("pauses only the conflicting file and retries it with the answer", async () => {
    const answer: { resolve?: (a: ConflictAnswer) => void } = {};
    const ask = vi.fn(
      () => new Promise<ConflictAnswer>((resolve) => { answer.resolve = resolve; }),
    );
    const h = harness({ askConflict: ask });
    h.queue.add(items("a", "b", "c"));
    h.jobs[0].fail(exists());
    await tick();
    expect(ask).toHaveBeenCalledWith("a", true);
    // b keeps going and c can start in the free slot while a waits.
    h.jobs[1].finish();
    await tick();
    expect(h.jobs.map((j) => j.name)).toEqual(["a", "b", "c"]);
    answer.resolve!({ choice: "replace", all: false });
    await tick();
    expect(h.jobs.at(-1)).toMatchObject({ name: "a", policy: "replace" });
    h.jobs.at(-1)!.finish();
    h.jobs[2].finish();
    await tick();
    expect(h.done.sort()).toEqual(["/d/a", "/d/b", "/d/c"]);
  });

  it("apply to all answers later conflicts without asking again", async () => {
    const ask = vi.fn(async (): Promise<ConflictAnswer> => ({ choice: "keep_both", all: true }));
    const h = harness({ askConflict: ask });
    h.queue.add(items("a", "b", "c"));
    h.jobs[0].fail(exists());
    h.jobs[1].fail(exists());
    await tick();
    await tick();
    expect(ask).toHaveBeenCalledTimes(1);
    const retried = h.jobs.slice(2);
    expect(retried.map((j) => j.policy)).toEqual(expect.arrayContaining(["keep_both"]));
    // c starts straight with the remembered policy once a slot frees up.
    h.jobs[2].finish();
    await tick();
    expect(h.jobs.find((j) => j.name === "c")?.policy).toBe("keep_both");
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("only one dialog at a time", async () => {
    let open = 0;
    let maxOpen = 0;
    const ask = vi.fn(async (): Promise<ConflictAnswer> => {
      open++;
      maxOpen = Math.max(maxOpen, open);
      await tick();
      open--;
      return { choice: "keep_both", all: false };
    });
    const h = harness({ askConflict: ask });
    h.queue.add(items("a", "b"));
    h.jobs[0].fail(exists());
    h.jobs[1].fail(exists());
    await new Promise((r) => setTimeout(r, 10));
    expect(ask).toHaveBeenCalledTimes(2);
    expect(maxOpen).toBe(1);
  });

  it("Stop cancels the remaining queue", async () => {
    const ask = vi.fn(async (): Promise<ConflictAnswer> => ({ choice: "stop", all: false }));
    const h = harness({ askConflict: ask });
    h.queue.add(items("a", "b", "c"));
    h.jobs[1].finish();
    await tick();
    h.jobs[0].fail(exists());
    await tick();
    await tick();
    expect(h.jobs.map((j) => j.name)).not.toContain("a#2");
    expect(h.drains).toHaveLength(1);
    expect(h.drains[0]).toMatchObject({ cancelled: false, error: null });
    expect(h.queue.active).toBe(false);
  });

  it("allowAll is false for the last remaining file", async () => {
    const ask = vi.fn(async (): Promise<ConflictAnswer> => ({ choice: "keep_both", all: false }));
    const h = harness({ askConflict: ask });
    h.queue.add(items("a"));
    h.jobs[0].fail(exists());
    await tick();
    expect(ask).toHaveBeenCalledWith("a", false);
  });
});

describe("speed and eta", () => {
  const MB = 1024 * 1024;
  it("averages over the last 3 seconds", () => {
    const samples = [
      { at: 0, bytes: 0 },
      { at: 1000, bytes: MB },
      { at: 4000, bytes: 7 * MB },
    ];
    // Window at t=4000 keeps the samples from t>=1000: 6 MB over 3 s.
    expect(speedOver(samples, 4000)).toBe(2 * MB);
  });
  it("is 0 with fewer than two recent samples and decays when stalled", () => {
    expect(speedOver([], 0)).toBe(0);
    expect(speedOver([{ at: 0, bytes: 5 }], 10)).toBe(0);
    const m = new SpeedMeter();
    m.record(0, 0);
    m.record(3 * MB, 1000);
    expect(m.speed(1000)).toBe(3 * MB);
    expect(m.speed(10_000)).toBe(0);
  });
  it("shows no speed until 1 s and 256 KiB are covered", () => {
    // Tiny files: 17 B over a second is not a speed.
    expect(speedOver([{ at: 0, bytes: 0 }, { at: 1000, bytes: 17 }], 1000)).toBe(0);
    // Fast but too short a window.
    expect(speedOver([{ at: 0, bytes: 0 }, { at: 400, bytes: 2 * MB }], 400)).toBe(0);
    // Both satisfied.
    expect(speedOver([{ at: 0, bytes: 0 }, { at: 1000, bytes: 256 * 1024 }], 1000)).toBe(256 * 1024);
  });
  it("estimates the time left", () => {
    expect(etaSeconds(1000, 100)).toBe(10);
    expect(etaSeconds(1000, 0)).toBeNull();
    expect(etaSeconds(0, 0)).toBe(0);
  });
  it("formats it", () => {
    expect(formatEta(4.2)).toBe("4 s");
    expect(formatEta(80)).toBe("1 min 20 s");
    expect(formatEta(7500)).toBe("2 h 5 min");
  });
  it("the queue reports speed and eta from a clock, and none while starting", async () => {
    let now = 0;
    const h = harness({ now: () => now });
    h.queue.add([{ file: file("a", 10 * MB), destDir: "/d" }]);
    now = 500;
    h.jobs[0].progress(MB);
    expect(h.queue.snapshot()).toMatchObject({ speedBps: 0, etaSec: null });
    now = 1000;
    h.jobs[0].progress(2 * MB);
    now = 2000;
    h.jobs[0].progress(4 * MB);
    const snap = h.queue.snapshot();
    expect(snap.speedBps).toBe(2 * MB);
    expect(snap.etaSec).toBe(3);
  });
});
