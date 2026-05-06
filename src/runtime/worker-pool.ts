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

interface SpawnInit {
  modulePath: string;
  toolId: string;
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

export class WorkerPool {
  /** Map workerId → Worker. A pool is per-tool (one worker reused across calls of the same tool). */
  private workers = new Map<string, { worker: Worker; pending: Map<string, PendingJob> }>();
  private readonly workerEntry: string;

  constructor(private readonly log: Logger, workerEntry?: string) {
    this.workerEntry = workerEntry ?? defaultWorkerEntry();
  }

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
      const init: SpawnInit = { modulePath: opts.modulePath, toolId: opts.toolId };
      const worker = new Worker(this.workerEntry, {
        workerData: init,
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
      entry!.worker.postMessage({
        jobId,
        inputs,
        fileRefs,
        credentials,
        scratchDir: opts.scratchDir,
      });
    });
  }

  async shutdown(): Promise<void> {
    const all = [...this.workers.values()];
    this.workers.clear();
    await Promise.all(all.map((e) => e.worker.terminate()));
  }
}
