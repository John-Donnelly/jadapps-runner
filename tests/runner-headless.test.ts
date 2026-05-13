import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRunner } from "../src/runner";

const dataDir = mkdtempSync(join(tmpdir(), "jadapps-runner-headless-"));
process.env.JADAPPS_RUNNER_DATA_DIR = dataDir;
// Point at an unroutable host so any best-effort sync calls fail fast and
// don't talk to the production server during tests.
process.env.JADAPPS_API_BASE = "http://127.0.0.1:1";
process.env.JADAPPS_RUNNER_LOG_LEVEL = "error";

afterAll(() => {
  // On Windows, better-sqlite3 sometimes holds the DB file open briefly
  // after shutdown; the data dir is in the OS temp area so a stale dir is
  // harmless. Don't fail the suite on a teardown EPERM.
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* tolerated */
  }
});

describe("startRunner headless mode", () => {
  it("returns a Runner with no HTTP server when headless: true", async () => {
    const runner = await startRunner({ headless: true });
    try {
      expect(runner.port).toBeNull();
      expect(runner.pairingToken).toBeNull();
      // The dep graph that the `mcp` CLI subcommand hands to McpServer
      // must still be wired even in headless mode.
      expect(runner.executor).toBeDefined();
      expect(runner.catalogue).toBeDefined();
      expect(runner.tokens).toBeDefined();
      expect(runner.credentials).toBeDefined();
      expect(runner.license).toBeDefined();
    } finally {
      await runner.shutdown();
    }
  });
});
