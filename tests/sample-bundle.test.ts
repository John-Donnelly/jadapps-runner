import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import pino from "pino";
import { WorkerPool } from "../src/runtime/worker-pool";
import { ScratchManager } from "../src/runtime/scratch";

describe("csv-row-count sample bundle (end-to-end via WorkerPool)", () => {
  let scratchBase: string;
  let bundlePath: string;
  let pool: WorkerPool;

  beforeAll(() => {
    // Worker pool spawns dist/runtime/worker.js. Build once if missing.
    const workerJs = resolve(__dirname, "..", "dist", "runtime", "worker.js");
    if (!existsSync(workerJs)) {
      execSync("npm run build", { cwd: resolve(__dirname, ".."), stdio: "inherit" });
    }
    scratchBase = mkdtempSync(join(tmpdir(), "jadapps-runner-test-"));
    // Stage the bundle code into a .mjs file the worker can dynamic-import.
    const envelope = JSON.parse(
      readFileSync(
        resolve(__dirname, "..", "..", "JAD Apps", "public", "runner-bundles", "csv-row-count-1.0.0.json"),
        "utf8",
      ),
    ) as { code: string };
    bundlePath = join(scratchBase, "csv-row-count.mjs");
    writeFileSync(bundlePath, envelope.code, "utf8");
    const workerEntry = resolve(__dirname, "..", "dist", "runtime", "worker.js");
    pool = new WorkerPool(pino({ level: "silent" }), workerEntry);
  });

  afterAll(async () => {
    await pool.shutdown();
    rmSync(scratchBase, { recursive: true, force: true });
  });

  it("counts rows in a CSV streamed from a file ref", async () => {
    const scratch = new ScratchManager(scratchBase);
    const runDir = scratch.acquire("test-run");
    mkdirSync(runDir, { recursive: true });
    const csv = "name,score\nada,42\nlinus,7\nmaggie,99\n";
    writeFileSync(join(runDir, "in.csv"), csv);

    const result = await pool.exec(
      { modulePath: bundlePath, toolId: "csv-row-count", scratchDir: runDir },
      {},
      [{ ref: "in.csv", bytes: Buffer.byteLength(csv), sha256: "n/a", mime: "text/csv", filename: "in.csv" }],
      {},
    );

    expect(result.ok).toBe(true);
    expect(result.outputs).toMatchObject({ rowCount: 3 });
    expect((result.outputs as { header: string[] }).header).toEqual(["name", "score"]);
    expect(result.bytesProcessed).toBeGreaterThan(0);
  });
});
