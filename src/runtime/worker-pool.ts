import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { cpus } from "node:os";
import type { Credential, FileRef, StepResult } from "../types.js";
import type { Logger } from "../log.js";

interface PendingJob {
  resolve: (result: StepResult) => void;
  reject: (err: Error) => void;
  onProgress?: (bytes: number) => void;
}

interface SpawnOpts {
  modulePath: string;
  toolId: string;
  scratchDir: string;
}

interface SpawnInit {
  modulePath: string;
  toolId: string;
}

interface WorkerEntry {
  worker: Worker;
  pending: Map<string, PendingJob>;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
// In dev (tsx) we run worker.ts; built we run dist/runtime/worker.js. Tests
// can override via the `workerEntry` constructor arg (or the env var) to
// point at the built artifact when running from the source tree.
function defaultWorkerEntry(): string {
  if (process.env.JADAPPS_RUNNER_WORKER_ENTRY) return process.env.JADAPPS_RUNNER_WORKER_ENTRY;
  if (process.env.JADAPPS_RUNNER_DEV === "true") return join(__dirname, "worker.ts");
  return join(__dirname, "worker.js");
}

export interface WorkerPoolOptions {
  /**
   * Cap on concurrent workers per (toolId, modulePath). Defaults to the
   * host CPU core count — that's the right number for CPU-bound built-in
   * tools (CSV transforms, hashing, regex security scans). Tools that
   * shell out (ffmpeg, qpdf) already saturate cores via their child
   * process, so a single worker thread can drive them just as well; this
   * cap doesn't hurt them because new workers only spawn when concurrent
   * jobs queue up.
   *
   * Pass 1 to restore the previous single-worker-per-tool behavior.
   */
  maxWorkersPerTool?: number;
}

export class WorkerPool {
  /**
   * Map (toolId:modulePath) → array of live workers. New jobs go to the
   * least-loaded existing worker; we only spawn a new one when every
   * existing worker has at least one in-flight job and we're still below
   * `maxWorkersPerTool`. This keeps a one-job workload using one worker
   * (matching previous behavior) while letting a burst of concurrent
   * jobs fan out across cores.
   */
  private workers = new Map<string, WorkerEntry[]>();
  private readonly workerEntry: string;
  private readonly maxWorkersPerTool: number;

  constructor(
    private readonly log: Logger,
    workerEntryOrOpts?: string | WorkerPoolOptions,
    opts: WorkerPoolOptions = {},
  ) {
    if (typeof workerEntryOrOpts === "string") {
      this.workerEntry = workerEntryOrOpts;
    } else {
      this.workerEntry = defaultWorkerEntry();
      opts = workerEntryOrOpts ?? opts;
    }
    const requested = opts.maxWorkersPerTool;
    const cap =
      typeof requested === "number" && requested >= 1
        ? Math.floor(requested)
        : Math.max(1, cpus().length);
    this.maxWorkersPerTool = cap;
  }

  async exec(
    opts: SpawnOpts,
    inputs: Record<string, unknown>,
    fileRefs: FileRef[],
    credentials: Record<string, Credential>,
    onProgress?: (bytes: number) => void,
  ): Promise<StepResult> {
    const key = `${opts.toolId}:${opts.modulePath}`;
    const entry = this.pickOrSpawnWorker(key, opts);

    const jobId = randomUUID();
    return new Promise<StepResult>((resolve, reject) => {
      entry.pending.set(jobId, { resolve, reject, onProgress: onProgress ?? (() => {}) });
      entry.worker.postMessage({
        jobId,
        inputs,
        fileRefs,
        credentials,
        scratchDir: opts.scratchDir,
      });
    });
  }

  /**
   * Pick the worker with the smallest pending queue; if every existing
   * worker has something in flight and we're under cap, spawn another.
   * Exported as `protected` (effectively private — TS allows test
   * subclasses) — callers should always go through `exec()`.
   */
  private pickOrSpawnWorker(key: string, opts: SpawnOpts): WorkerEntry {
    let entries = this.workers.get(key);
    if (!entries || entries.length === 0) {
      const fresh = this.spawnWorker(key, opts);
      this.workers.set(key, [fresh]);
      return fresh;
    }

    let best: WorkerEntry | null = null;
    for (const e of entries) {
      if (best === null || e.pending.size < best.pending.size) best = e;
    }
    if (best && best.pending.size === 0) return best;
    if (entries.length < this.maxWorkersPerTool) {
      const fresh = this.spawnWorker(key, opts);
      entries.push(fresh);
      return fresh;
    }
    // All workers busy and we're at cap; piggyback onto the least-loaded one.
    return best!;
  }

  private spawnWorker(key: string, opts: SpawnOpts): WorkerEntry {
    const init: SpawnInit = { modulePath: opts.modulePath, toolId: opts.toolId };
    const worker = new Worker(this.workerEntry, {
      workerData: init,
      env: process.env,
    });
    const pending = new Map<string, PendingJob>();
    const entry: WorkerEntry = { worker, pending };

    worker.on(
      "message",
      (msg: { type: string; jobId: string; result?: StepResult; bytes?: number }) => {
        const job = pending.get(msg.jobId);
        if (!job) return;
        if (msg.type === "progress" && typeof msg.bytes === "number") {
          job.onProgress?.(msg.bytes);
        } else if (msg.type === "result" && msg.result) {
          pending.delete(msg.jobId);
          job.resolve(msg.result);
        }
      },
    );
    worker.on("error", (err) => {
      for (const job of pending.values()) job.reject(err);
      pending.clear();
      this.removeEntry(key, entry);
      this.log.error({ err, toolId: opts.toolId }, "worker crashed");
    });
    worker.on("exit", (code) => {
      if (code !== 0) {
        for (const job of pending.values()) {
          job.reject(new Error(`worker exited with code ${code}`));
        }
      }
      pending.clear();
      this.removeEntry(key, entry);
    });

    return entry;
  }

  private removeEntry(key: string, entry: WorkerEntry): void {
    const entries = this.workers.get(key);
    if (!entries) return;
    const idx = entries.indexOf(entry);
    if (idx >= 0) entries.splice(idx, 1);
    if (entries.length === 0) this.workers.delete(key);
  }

  async shutdown(): Promise<void> {
    const all: Worker[] = [];
    for (const entries of this.workers.values()) {
      for (const e of entries) all.push(e.worker);
    }
    this.workers.clear();
    await Promise.all(all.map((w) => w.terminate()));
  }

  /** Exposed for tests/diagnostics. Returns the current per-key worker count. */
  workerCountFor(toolId: string, modulePath: string): number {
    return this.workers.get(`${toolId}:${modulePath}`)?.length ?? 0;
  }
}
