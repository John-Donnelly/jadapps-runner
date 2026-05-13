import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { WorkerPool } from "../src/runtime/worker-pool";

const log = pino({ level: "silent" });

// Minimal worker script: waits `delayMs` ms (from inputs), then replies. Used
// to drive the pool's scheduling logic without needing the real ToolModule
// loader path.
const WORKER_SCRIPT = `
import { parentPort, workerData } from "node:worker_threads";
const port = parentPort;
const toolId = workerData?.toolId ?? "unknown";
port.on("message", async (job) => {
  const delayMs = Number(job?.inputs?.delayMs ?? 0);
  if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  port.postMessage({
    type: "result",
    jobId: job.jobId,
    result: {
      ok: true,
      outputs: { toolId, delayedFor: delayMs },
      fileRefs: [],
      bytesProcessed: 0,
      durationMs: delayMs,
    },
  });
});
`;

let scratch: string;
let workerEntry: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "jadapps-worker-pool-"));
  workerEntry = join(scratch, "worker.mjs");
  writeFileSync(workerEntry, WORKER_SCRIPT, "utf8");
});

afterAll(() => {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    /* tolerated on Windows */
  }
});

describe("WorkerPool scheduling", () => {
  it("uses one worker for serial calls of the same tool", async () => {
    const pool = new WorkerPool(log, workerEntry, { maxWorkersPerTool: 4 });
    try {
      const opts = { modulePath: "irrelevant", toolId: "t1", scratchDir: scratch };
      const a = await pool.exec(opts, { delayMs: 0 }, [], {});
      expect(a.ok).toBe(true);
      expect(pool.workerCountFor("t1", "irrelevant")).toBe(1);
      const b = await pool.exec(opts, { delayMs: 0 }, [], {});
      expect(b.ok).toBe(true);
      // No new worker should have spawned for a second serial call.
      expect(pool.workerCountFor("t1", "irrelevant")).toBe(1);
    } finally {
      await pool.shutdown();
    }
  });

  it("fans out concurrent calls of the same tool across up to maxWorkersPerTool workers", async () => {
    const pool = new WorkerPool(log, workerEntry, { maxWorkersPerTool: 3 });
    try {
      const opts = { modulePath: "irrelevant", toolId: "t2", scratchDir: scratch };
      const five = await Promise.all([
        pool.exec(opts, { delayMs: 80 }, [], {}),
        pool.exec(opts, { delayMs: 80 }, [], {}),
        pool.exec(opts, { delayMs: 80 }, [], {}),
        pool.exec(opts, { delayMs: 80 }, [], {}),
        pool.exec(opts, { delayMs: 80 }, [], {}),
      ]);
      expect(five.every((r) => r.ok)).toBe(true);
      // 5 concurrent calls; cap is 3 → exactly 3 workers spawned.
      expect(pool.workerCountFor("t2", "irrelevant")).toBe(3);
    } finally {
      await pool.shutdown();
    }
  });

  it("keeps separate worker counts per tool key", async () => {
    const pool = new WorkerPool(log, workerEntry, { maxWorkersPerTool: 2 });
    try {
      const optsA = { modulePath: "irrelevant", toolId: "ta", scratchDir: scratch };
      const optsB = { modulePath: "irrelevant", toolId: "tb", scratchDir: scratch };
      await Promise.all([
        pool.exec(optsA, { delayMs: 50 }, [], {}),
        pool.exec(optsA, { delayMs: 50 }, [], {}),
        pool.exec(optsB, { delayMs: 50 }, [], {}),
      ]);
      expect(pool.workerCountFor("ta", "irrelevant")).toBe(2);
      expect(pool.workerCountFor("tb", "irrelevant")).toBe(1);
    } finally {
      await pool.shutdown();
    }
  });

  it("honors a cap of 1 (legacy single-worker-per-tool behavior)", async () => {
    const pool = new WorkerPool(log, workerEntry, { maxWorkersPerTool: 1 });
    try {
      const opts = { modulePath: "irrelevant", toolId: "t3", scratchDir: scratch };
      await Promise.all([
        pool.exec(opts, { delayMs: 30 }, [], {}),
        pool.exec(opts, { delayMs: 30 }, [], {}),
        pool.exec(opts, { delayMs: 30 }, [], {}),
      ]);
      expect(pool.workerCountFor("t3", "irrelevant")).toBe(1);
    } finally {
      await pool.shutdown();
    }
  });
});
