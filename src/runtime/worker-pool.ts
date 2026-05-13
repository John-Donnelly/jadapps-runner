import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
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

/**
 * Locate worker.js / worker.ts across the three layouts the runner ships in.
 * Same issue as resolveBuiltinModulePath: tsup bundles src/runtime/worker-pool.ts
 * into dist/cli.js at the top level, so `__dirname` for the resolved code is
 * `dist/` and `join(__dirname, "worker.js")` overshoots — the worker actually
 * lives at `dist/runtime/worker.js`.
 *
 * Layouts:
 *   - tsx dev:        __dirname = src/runtime,  entry = src/runtime/worker.ts
 *   - tsup unbundled: __dirname = dist/runtime, entry = dist/runtime/worker.js
 *   - tsup bundled:   __dirname = dist          entry = dist/runtime/worker.js
 *
 * `JADAPPS_RUNNER_WORKER_ENTRY` always wins so tests can pin an explicit path.
 */
function defaultWorkerEntry(): string {
  const override = process.env.JADAPPS_RUNNER_WORKER_ENTRY;
  if (override) return override;
  const ext = process.env.JADAPPS_RUNNER_DEV === "true" ? ".ts" : ".js";
  const candidates = [
    join(__dirname, `worker${ext}`),
    join(__dirname, "runtime", `worker${ext}`),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // Fall back to the original guess so the eventual `new Worker` error
  // surfaces a recognizable path. Returns the first candidate (matches the
  // historical pre-bundling layout) — same behavior as before this patch
  // when neither file exists.
  return candidates[0]!;
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
