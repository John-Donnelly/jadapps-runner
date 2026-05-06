import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import pino from "pino";
import { WorkerPool } from "../src/runtime/worker-pool";
import { ScratchManager } from "../src/runtime/scratch";

describe("slack-postmessage bundle (with mocked Slack server)", () => {
  let scratchBase: string;
  let bundlePath: string;
  let pool: WorkerPool;
  let server: { close: () => Promise<void>; lastRequest: { headers: Record<string, string>; body: string } | null; clear: () => void };

  beforeAll(async () => {
    const workerJs = resolve(__dirname, "..", "dist", "runtime", "worker.js");
    if (!existsSync(workerJs)) {
      execSync("npm run build", { cwd: resolve(__dirname, ".."), stdio: "inherit" });
    }
    scratchBase = mkdtempSync(join(tmpdir(), "jadapps-slack-test-"));

    // Spin up ONE local server for all tests and rewrite the bundle once
    // pointing at it. WorkerPool caches workers by modulePath, so we can't
    // change the bundle between tests — settle on a single server URL.
    const http = await import("node:http");
    const captured: { value: { headers: Record<string, string>; body: string } | null } = { value: null };
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString("utf8")));
      req.on("end", () => {
        captured.value = {
          headers: Object.fromEntries(
            Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : (v ?? "")]),
          ),
          body,
        };
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, channel: "C123", ts: "1700000000.0001" }));
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const addr = srv.address() as { port: number };
    const url = `http://127.0.0.1:${addr.port}/api/chat.postMessage`;

    const envelope = JSON.parse(
      readFileSync(
        resolve(__dirname, "..", "..", "JAD Apps", "public", "runner-bundles", "slack-postmessage-1.0.0.json"),
        "utf8",
      ),
    ) as { code: string };
    bundlePath = join(scratchBase, "slack-postmessage.mjs");
    writeFileSync(
      bundlePath,
      envelope.code.replace(/const SLACK_URL = "[^"]+";/, `const SLACK_URL = ${JSON.stringify(url)};`),
      "utf8",
    );

    pool = new WorkerPool(pino({ level: "silent" }), workerJs);

    server = {
      close: () => new Promise<void>((r) => srv.close(() => r())),
      get lastRequest() {
        return captured.value;
      },
      clear: () => {
        captured.value = null;
      },
    };
  });

  afterAll(async () => {
    await pool.shutdown();
    await server.close();
    rmSync(scratchBase, { recursive: true, force: true });
  });

  beforeEach(() => {
    server.clear();
  });

  it("sends a Bearer-authed POST with channel and text from config", async () => {
    const scratch = new ScratchManager(scratchBase);
    const runDir = scratch.acquire("slack-1");
    mkdirSync(runDir, { recursive: true });

    const result = await pool.exec(
      { modulePath: bundlePath, toolId: "slack-postmessage", scratchDir: runDir },
      { channel: "#alerts", text: "build finished", credentialRef: "slack-bot" },
      [],
      {
        "slack-bot": {
          ref: "slack-bot",
          type: "api_key",
          data: { value: "xoxb-secret-token" },
          createdAt: 0,
          updatedAt: 0,
        },
      },
    );

    expect(result.ok).toBe(true);
    const lr = server.lastRequest;
    expect(lr).not.toBeNull();
    expect(lr!.headers["authorization"]).toBe("Bearer xoxb-secret-token");
    expect(lr!.headers["content-type"]).toMatch(/application\/json/);
    const sent = JSON.parse(lr!.body);
    expect(sent.channel).toBe("#alerts");
    expect(sent.text).toBe("build finished");
  });

  it("falls back to upstream file text when config.text is omitted", async () => {
    const scratch = new ScratchManager(scratchBase);
    const runDir = scratch.acquire("slack-2");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "in.txt"), "incident: db latency 800ms");

    const result = await pool.exec(
      { modulePath: bundlePath, toolId: "slack-postmessage", scratchDir: runDir },
      { channel: "C0001", credentialRef: "slack-bot" },
      [{ ref: "in.txt", bytes: 30, sha256: "n/a", mime: "text/plain", filename: "in.txt" }],
      {
        "slack-bot": {
          ref: "slack-bot",
          type: "api_key",
          data: { value: "xoxb-secret-token" },
          createdAt: 0,
          updatedAt: 0,
        },
      },
    );

    expect(result.ok).toBe(true);
    const sent = JSON.parse(server.lastRequest!.body);
    expect(sent.text).toBe("incident: db latency 800ms");
  });

  it("returns ok=false with error code when credential is missing", async () => {
    const scratch = new ScratchManager(scratchBase);
    const runDir = scratch.acquire("slack-3");
    mkdirSync(runDir, { recursive: true });
    const result = await pool.exec(
      { modulePath: bundlePath, toolId: "slack-postmessage", scratchDir: runDir },
      { channel: "#x", text: "hi", credentialRef: "missing" },
      [],
      {},
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("credential_missing");
  });
});
