// Pure scheduler for the file manager's upload queue: runs a few files at a
// time, pauses one file on a name conflict, and tracks overall progress, speed
// and time remaining. React wiring lives in components/useFileActions.ts.
import type { FsConflictPolicy } from "./api";
import { RemoteFileError } from "./api";

export const UPLOAD_CONCURRENCY = 2;
/** Window the speed is averaged over. */
export const SPEED_WINDOW_MS = 3000;
/** No speed is shown until the window spans this long... */
export const SPEED_MIN_SPAN_MS = 1000;
/** ...and this much was acknowledged in it (so tiny files give no "17 B/s"). */
export const SPEED_MIN_BYTES = 256 * 1024;

// ---------------------------------------------------------------- speed

export interface SpeedSample {
  at: number;
  bytes: number;
}

/**
 * Bytes per second over the samples inside the last `windowMs`. 0 (unknown)
 * until the window spans `SPEED_MIN_SPAN_MS` and holds `SPEED_MIN_BYTES`, so a
 * stalled transfer decays to 0.
 */
export function speedOver(samples: readonly SpeedSample[], now: number, windowMs = SPEED_WINDOW_MS): number {
  const recent = samples.filter((s) => now - s.at <= windowMs);
  if (recent.length < 2) return 0;
  const first = recent[0];
  // The window ends now, so a stall lowers the average instead of freezing it.
  const dt = now - first.at;
  const bytes = recent[recent.length - 1].bytes - first.bytes;
  if (dt < SPEED_MIN_SPAN_MS || bytes < SPEED_MIN_BYTES) return 0;
  return Math.max(0, bytes / (dt / 1000));
}

/** Seconds left at `speed` bytes/s, or null when it cannot be told. */
export function etaSeconds(remainingBytes: number, speed: number): number | null {
  if (remainingBytes <= 0) return 0;
  if (speed <= 0) return null;
  return remainingBytes / speed;
}

/** "5 s", "1 min 20 s", "2 h 5 min". */
export function formatEta(seconds: number): string {
  const s = Math.max(1, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min${s % 60 ? ` ${s % 60} s` : ""}`;
  const h = Math.floor(m / 60);
  return `${h} h${m % 60 ? ` ${m % 60} min` : ""}`;
}

/** Rolling samples of a cumulative byte counter. */
export class SpeedMeter {
  private samples: SpeedSample[] = [];
  constructor(private readonly windowMs = SPEED_WINDOW_MS) {}
  record(bytes: number, at: number): void {
    this.samples.push({ at, bytes });
    // Keep one sample older than the window so the average always has an anchor.
    while (this.samples.length > 2 && at - this.samples[1].at > this.windowMs) this.samples.shift();
  }
  speed(now: number): number {
    return speedOver(this.samples, now, this.windowMs);
  }
}

// ---------------------------------------------------------------- queue

export interface QueueFile {
  name: string;
  size: number;
}

export interface QueueItem<F extends QueueFile = QueueFile> {
  file: F;
  destDir: string;
}

export type ConflictChoice = "keep_both" | "replace";
export type ConflictAnswer = { choice: ConflictChoice | "stop"; all: boolean };

export interface QueueSnapshot {
  /** Files finished (uploaded) in this batch. */
  filesDone: number;
  /** Files in this batch, including queued ones. */
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
  /** Names of the files being sent right now. */
  active: string[];
  speedBps: number;
  etaSec: number | null;
}

export interface QueueResult {
  /** Paths that landed, in completion order. */
  uploaded: string[];
  /** The failure that stopped the queue, if any. */
  error: unknown;
  /** Stopped by cancel() (not by Stop in the conflict dialog or an error). */
  cancelled: boolean;
}

export interface QueueDeps<F extends QueueFile> {
  /** Uploads one file; throws a RemoteFileError("exists") when the name is taken. */
  run: (
    item: QueueItem<F>,
    ctx: { policy: FsConflictPolicy; signal: AbortSignal; onProgress: (sent: number) => void },
  ) => Promise<{ path: string; size: number }>;
  askConflict: (name: string, allowAll: boolean) => Promise<ConflictAnswer>;
  /** A file landed. */
  onFileDone?: (path: string, item: QueueItem<F>) => void;
  onChange?: (snapshot: QueueSnapshot) => void;
  /** Nothing queued or running any more. */
  onDrain?: (result: QueueResult) => void;
  concurrency?: number;
  now?: () => number;
}

const isExists = (err: unknown): boolean => err instanceof RemoteFileError && err.code === "exists";
const isAbort = (err: unknown): boolean => err instanceof Error && err.name === "AbortError";

interface Entry<F extends QueueFile> {
  item: QueueItem<F>;
  done: number;
}

export class UploadQueue<F extends QueueFile = QueueFile> {
  private pending: Entry<F>[] = [];
  private running = new Set<Entry<F>>();
  private controller = new AbortController();
  private meter = new SpeedMeter();
  private uploaded: string[] = [];
  private filesTotal = 0;
  private bytesTotal = 0;
  private finishedBytes = 0;
  private filesDone = 0;
  private applyAll: ConflictChoice | null = null;
  private error: unknown = null;
  private cancelled = false;
  private halted = false;
  private conflictChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: QueueDeps<F>) {}

  get active(): boolean {
    return this.pending.length > 0 || this.running.size > 0;
  }

  /** Queues files. Starts a fresh batch when the queue was idle. */
  add(items: QueueItem<F>[]): void {
    if (items.length === 0) return;
    if (!this.active) this.reset();
    for (const item of items) {
      this.pending.push({ item, done: 0 });
      this.filesTotal++;
      this.bytesTotal += item.file.size;
    }
    this.meter.record(this.bytesDone(), this.now());
    this.pump();
    this.emit();
  }

  /** Stops everything: running files are aborted, queued ones dropped. */
  cancel(): void {
    if (!this.active) return;
    this.cancelled = true;
    this.halt();
  }

  /** Re-emits the snapshot (speed decays while nothing arrives). */
  tick(): void {
    if (this.active) this.emit();
  }

  snapshot(): QueueSnapshot {
    const now = this.now();
    const bytesDone = this.bytesDone();
    const speedBps = this.meter.speed(now);
    return {
      filesDone: this.filesDone,
      filesTotal: this.filesTotal,
      bytesDone,
      bytesTotal: this.bytesTotal,
      active: [...this.running].map((e) => e.item.file.name),
      speedBps,
      etaSec: etaSeconds(this.bytesTotal - bytesDone, speedBps),
    };
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private reset(): void {
    this.controller = new AbortController();
    this.meter = new SpeedMeter();
    this.uploaded = [];
    this.filesTotal = 0;
    this.bytesTotal = 0;
    this.finishedBytes = 0;
    this.filesDone = 0;
    this.applyAll = null;
    this.error = null;
    this.cancelled = false;
    this.halted = false;
  }

  private bytesDone(): number {
    let done = this.finishedBytes;
    for (const e of this.running) done += e.done;
    return done;
  }

  private emit(): void {
    // Nothing to show once drained (and the drain handler has cleared the UI).
    if (!this.active) return;
    this.deps.onChange?.(this.snapshot());
  }

  private halt(): void {
    this.halted = true;
    this.pending = [];
    this.controller.abort();
  }

  private pump(): void {
    const limit = this.deps.concurrency ?? UPLOAD_CONCURRENCY;
    while (!this.halted && this.running.size < limit && this.pending.length > 0) {
      const entry = this.pending.shift()!;
      this.running.add(entry);
      void this.runEntry(entry);
    }
  }

  private async runEntry(entry: Entry<F>): Promise<void> {
    const { item } = entry;
    try {
      let policy: FsConflictPolicy = this.applyAll ?? "error";
      for (;;) {
        try {
          const result = await this.deps.run(item, {
            policy,
            signal: this.controller.signal,
            onProgress: (sent) => {
              entry.done = sent;
              this.meter.record(this.bytesDone(), this.now());
              this.emit();
            },
          });
          this.uploaded.push(result.path);
          this.finishedBytes += item.file.size;
          this.filesDone++;
          this.running.delete(entry);
          this.deps.onFileDone?.(result.path, item);
          break;
        } catch (err) {
          entry.done = 0;
          if (this.halted) return;
          if (isExists(err) && policy === "error") {
            const answer = await this.askConflict(entry);
            if (answer.choice === "stop") {
              this.halt();
              return;
            }
            if (this.halted) return;
            policy = answer.choice;
            continue;
          }
          throw err;
        }
      }
    } catch (err) {
      if (!this.halted) {
        if (!isAbort(err)) this.error = err;
        this.halt();
      }
    } finally {
      this.running.delete(entry);
      this.meter.record(this.bytesDone(), this.now());
      if (this.halted || this.pending.length === 0) this.settleIfIdle();
      this.pump();
      this.emit();
    }
  }

  /** One dialog at a time; later files reuse an earlier "apply to all". */
  private askConflict(entry: Entry<F>): Promise<ConflictAnswer> {
    const next = this.conflictChain.then(async (): Promise<ConflictAnswer> => {
      if (this.halted) return { choice: "stop", all: false };
      if (this.applyAll) return { choice: this.applyAll, all: true };
      const others = this.pending.length + this.running.size - 1;
      const answer = await this.deps.askConflict(entry.item.file.name, others > 0);
      if (answer.all && answer.choice !== "stop") this.applyAll = answer.choice;
      return answer;
    });
    this.conflictChain = next.catch(() => undefined);
    return next;
  }

  private settleIfIdle(): void {
    if (this.running.size > 0 || (this.pending.length > 0 && !this.halted)) return;
    this.deps.onDrain?.({ uploaded: [...this.uploaded], error: this.error, cancelled: this.cancelled });
  }
}
