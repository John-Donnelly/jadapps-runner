import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import pino from "pino";
import { WorkerPool } from "../src/runtime/worker-pool";
import { ScratchManager } from "../src/runtime/scratch";

describe("csv-anonymize bundle (end-to-end via WorkerPool)", () => {
  let scratchBase: string;
  let bundlePath: string;
  let pool: WorkerPool;

  beforeAll(() => {
    const workerJs = resolve(__dirname, "..", "dist", "runtime", "worker.js");
    if (!existsSync(workerJs)) {
      execSync("npm run build", { cwd: resolve(__dirname, ".."), stdio: "inherit" });
    }
    scratchBase = mkdtempSync(join(tmpdir(), "jadapps-anon-test-"));

    const envelope = JSON.parse(
      readFileSync(
        resolve(__dirname, "..", "..", "JAD Apps", "public", "runner-bundles", "csv-anonymize-1.0.0.json"),
        "utf8",
      ),
    ) as { code: string };
    bundlePath = join(scratchBase, "csv-anonymize.mjs");
    writeFileSync(bundlePath, envelope.code, "utf8");

    pool = new WorkerPool(pino({ level: "silent" }), workerJs);
  });

  afterAll(async () => {
    await pool.shutdown();
    rmSync(scratchBase, { recursive: true, force: true });
  });

  it("auto-detects email column and hashes it; writes anonymised output file", async () => {
    const scratch = new ScratchManager(scratchBase);
    const runDir = scratch.acquire("anon-run-1");
    mkdirSync(runDir, { recursive: true });
    const csv =
      "name,email,score\nada,ada@example.com,42\nlinus,linus@example.com,7\n";
    writeFileSync(join(runDir, "in.csv"), csv);

    const result = await pool.exec(
      { modulePath: bundlePath, toolId: "csv-anonymize", scratchDir: runDir },
      {},
      [{ ref: "in.csv", bytes: Buffer.byteLength(csv), sha256: "n/a", mime: "text/csv", filename: "in.csv" }],
      {},
    );

    expect(result.ok).toBe(true);
    expect(result.fileRefs.length).toBe(1);
    const out = result.fileRefs[0]!;
    const written = readFileSync(join(runDir, out.ref), "utf8").trim().split("\n");
    expect(written[0]).toBe("name,email,score"); // header preserved
    // Both name and email match the auto-detect regex list → both hashed.
    const row1 = written[1]!.split(",");
    expect(row1[0]).toMatch(/^[0-9a-f]{16}$/); // name hashed
    expect(row1[1]).toMatch(/^[0-9a-f]{16}$/); // email hashed
    expect(row1[0]).not.toBe(row1[1]); // distinct hashes
    expect(row1[2]).toBe("42"); // score passed through
    const outputs = result.outputs as { autoDetected: boolean; appliedRules: Array<{ column: string; mode: string }> };
    expect(outputs.autoDetected).toBe(true);
    expect(outputs.appliedRules).toContainEqual({ column: "email", mode: "hash" });
    expect(outputs.appliedRules).toContainEqual({ column: "name", mode: "hash" });
  });

  it("applies explicit rules: drop, mask, sequential", async () => {
    const scratch = new ScratchManager(scratchBase);
    const runDir = scratch.acquire("anon-run-2");
    mkdirSync(runDir, { recursive: true });
    const csv = "id,phone,note\n1,07700900123,hello\n2,07700900456,world\n";
    writeFileSync(join(runDir, "in.csv"), csv);

    const result = await pool.exec(
      { modulePath: bundlePath, toolId: "csv-anonymize", scratchDir: runDir },
      {
        autoDetect: false,
        rules: [
          { column: "id", mode: "sequential" },
          { column: "phone", mode: "mask", keepStart: 4, keepEnd: 3 },
          { column: "note", mode: "drop" },
        ],
      },
      [{ ref: "in.csv", bytes: Buffer.byteLength(csv), sha256: "n/a", mime: "text/csv", filename: "in.csv" }],
      {},
    );

    expect(result.ok).toBe(true);
    const out = result.fileRefs[0]!;
    const lines = readFileSync(join(runDir, out.ref), "utf8").trim().split("\n");
    expect(lines[0]).toBe("id,phone"); // note dropped
    expect(lines[1]).toBe("id-1,0770****123");
    expect(lines[2]).toBe("id-2,0770****456");
  });
});
