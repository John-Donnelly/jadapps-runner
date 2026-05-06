import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
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

const __dirname = dirname(fileURLToPath(import.meta.url));
// In dev (tsx) we run worker.ts; built we run dist/runtime/worker.js
const WORKER_ENTRY =
  process.env.JADAPPS_RUNNER_DEV === "true"
    ? join(__dirname, "worker.ts")
    : join(__dirname, "worker.js");

export class WorkerPool {
  /** Map workerId → Worker. A pool is per-tool (one worker reused across calls of the same tool). */
  private workers = new Map<string, { worker: Worker; pending: Map<string, PendingJob> }>();

  constructor(private readonly log: Logger) {}

  async exec(
    opts: SpawnOpts,
    inputs: Record<string, unknown>,
    fileRefs: FileRef[],
    credentials: Record<string, Credential>,
    onProgress?: (bytes: number) => void,
  ): Promise<StepResult> {
    const key = `${opts.toolId}:${opts.modulePath}`;
    let entry = this.workers.get(key);
    if (!entry) {
      const worker = new Worker(WORKER_ENTRY, {
        workerData: opts,
        env: process.env,
      });
      const pending = new Map<string, PendingJob>();
      worker.on("message", (msg: { type: string; jobId: string; result?: StepResult; bytes?: number }) => {
        const job = pending.get(msg.jobId);
        if (!job) return;
        if (msg.type === "progress" && typeof msg.bytes === "number") {
          job.onProgress?.(msg.bytes);
        } else if (msg.type === "result" && msg.result) {
          pending.delete(msg.jobId);
          job.resolve(msg.result);
        }
      });
      worker.on("error", (err) => {
        for (const job of pending.values()) job.reject(err);
        pending.clear();
        this.workers.delete(key);
        this.log.error({ err, toolId: opts.toolId }, "worker crashed");
      });
      worker.on("exit", (code) => {
        if (code !== 0) {
          for (const job of pending.values()) {
            job.reject(new Error(`worker exited with code ${code}`));
          }
        }
        pending.clear();
        this.workers.delete(key);
      });
      entry = { worker, pending };
      this.workers.set(key, entry);
    }

    const jobId = randomUUID();
    return new Promise<StepResult>((resolve, reject) => {
      entry!.pending.set(jobId, { resolve, reject, onProgress: onProgress ?? (() => {}) });
      entry!.worker.postMessage({ jobId, inputs, fileRefs, credentials });
    });
  }

  async shutdown(): Promise<void> {
    const all = [...this.workers.values()];
    this.workers.clear();
    await Promise.all(all.map((e) => e.worker.terminate()));
  }
}
