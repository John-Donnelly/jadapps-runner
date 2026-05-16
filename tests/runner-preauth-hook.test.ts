import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ApiClient } from "../src/api/client";
import { SecretStore } from "../src/auth/keychain";
import { loadConfig } from "../src/config";
import { maybeRedeemPreauth } from "../src/runner";

const noopLogger = {
  child: () => noopLogger,
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
} as unknown as ConstructorParameters<typeof ApiClient>[1];

interface MockServer {
  url: string;
  calls: number;
  responder: () => { status: number; body: string };
  close: () => Promise<void>;
}

function startMock(): Promise<MockServer> {
  let calls = 0;
  let responder: MockServer["responder"] = () => ({
    status: 500,
    body: '{"error":"no responder"}',
  });
  const server: Server = createServer((_req: IncomingMessage, res) => {
    calls += 1;
    const r = responder();
    res.statusCode = r.status;
    res.setHeader("content-type", "application/json");
    res.end(r.body);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      const handle: MockServer = {
        url: `http://127.0.0.1:${addr.port}`,
        get calls() {
          return calls;
        },
        get responder() {
          return responder;
        },
        set responder(fn) {
          responder = fn;
        },
        close: () =>
          new Promise<void>((closeResolve) => server.close(() => closeResolve())),
      } as MockServer;
      resolve(handle);
    });
  });
}

describe("maybeRedeemPreauth (first-launch hook)", () => {
  let tmp: string;
  let mock: MockServer;
  let savedDataDir: string | undefined;
  let savedApiBase: string | undefined;
  let savedEnvToken: string | undefined;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "jadapps-runner-hook-"));
    savedDataDir = process.env.JADAPPS_RUNNER_DATA_DIR;
    savedApiBase = process.env.JADAPPS_API_BASE;
    savedEnvToken = process.env.JADAPPS_PREAUTH_TOKEN;
    process.env.JADAPPS_RUNNER_DATA_DIR = tmp;
    delete process.env.JADAPPS_PREAUTH_TOKEN;
    mock = await startMock();
    process.env.JADAPPS_API_BASE = mock.url;
  });

  afterEach(async () => {
    if (savedDataDir === undefined) delete process.env.JADAPPS_RUNNER_DATA_DIR;
    else process.env.JADAPPS_RUNNER_DATA_DIR = savedDataDir;
    if (savedApiBase === undefined) delete process.env.JADAPPS_API_BASE;
    else process.env.JADAPPS_API_BASE = savedApiBase;
    if (savedEnvToken === undefined) delete process.env.JADAPPS_PREAUTH_TOKEN;
    else process.env.JADAPPS_PREAUTH_TOKEN = savedEnvToken;
    await mock.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function makeDeps() {
    const cfg = loadConfig();
    const secrets = new SecretStore(cfg.dataDir);
    const api = new ApiClient(cfg.apiBase, noopLogger);
    return { cfg, secrets, api, log: noopLogger };
  }

  it("does nothing when no token source is present", async () => {
    const deps = makeDeps();
    await maybeRedeemPreauth(deps);
    expect(mock.calls).toBe(0);
    expect(existsSync(join(deps.cfg.dataDir, "pairing.json"))).toBe(false);
  });

  it("redeems from env var and unsets it on success", async () => {
    process.env.JADAPPS_PREAUTH_TOKEN = "ENV-TOKEN";
    mock.responder = () => ({
      status: 200,
      body: JSON.stringify({
        deviceId: "dev-env",
        userId: "u-env",
        refreshToken: "rt-env",
      }),
    });

    const deps = makeDeps();
    await maybeRedeemPreauth(deps);

    expect(mock.calls).toBe(1);
    expect(existsSync(join(deps.cfg.dataDir, "pairing.json"))).toBe(true);
    expect(process.env.JADAPPS_PREAUTH_TOKEN).toBeUndefined();
  });

  it("redeems from marker file and deletes it on success", async () => {
    const deps = makeDeps();
    const markerPath = join(deps.cfg.dataDir, "preauth.json");
    writeFileSync(
      markerPath,
      JSON.stringify({
        preauthToken: "FILE-TOKEN",
        deviceName: "alice-laptop",
        platformTag: "win32-msix",
      }),
      "utf8",
    );

    mock.responder = () => ({
      status: 200,
      body: JSON.stringify({
        deviceId: "dev-file",
        userId: "u-file",
        refreshToken: "rt-file",
      }),
    });

    await maybeRedeemPreauth(deps);

    expect(mock.calls).toBe(1);
    expect(existsSync(markerPath)).toBe(false);
    const persisted = JSON.parse(
      readFileSync(join(deps.cfg.dataDir, "pairing.json"), "utf8"),
    ) as { deviceId: string };
    expect(persisted.deviceId).toBe("dev-file");
  });

  it("consumes the token without redeeming when already paired", async () => {
    const deps = makeDeps();
    writeFileSync(
      join(deps.cfg.dataDir, "pairing.json"),
      JSON.stringify({ deviceId: "old", userId: "old" }),
      "utf8",
    );
    const markerPath = join(deps.cfg.dataDir, "preauth.json");
    writeFileSync(markerPath, JSON.stringify({ preauthToken: "T" }), "utf8");

    await maybeRedeemPreauth(deps);

    // Should NOT have called the server
    expect(mock.calls).toBe(0);
    // But should have consumed the marker so we don't retry forever
    expect(existsSync(markerPath)).toBe(false);
  });

  it("consumes the token and continues startup on redemption failure", async () => {
    process.env.JADAPPS_PREAUTH_TOKEN = "BAD-TOKEN";
    mock.responder = () => ({
      status: 401,
      body: JSON.stringify({ error: "expired_preauth_token" }),
    });

    const deps = makeDeps();
    // Should NOT throw — the runner has to keep starting even if pairing fails.
    await expect(maybeRedeemPreauth(deps)).resolves.toBeUndefined();
    expect(mock.calls).toBe(1);
    expect(process.env.JADAPPS_PREAUTH_TOKEN).toBeUndefined();
    expect(existsSync(join(deps.cfg.dataDir, "pairing.json"))).toBe(false);
  });

  it("ignores a malformed marker file and continues startup", async () => {
    const deps = makeDeps();
    const markerPath = join(deps.cfg.dataDir, "preauth.json");
    writeFileSync(markerPath, "{not json", "utf8");

    await expect(maybeRedeemPreauth(deps)).resolves.toBeUndefined();
    expect(mock.calls).toBe(0);
    // Malformed marker should be left alone — we couldn't parse it so
    // we don't know if it's safe to delete.
    expect(existsSync(markerPath)).toBe(true);
  });
});
