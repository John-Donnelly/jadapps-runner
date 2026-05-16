import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ApiClient } from "../src/api/client";
import { PreauthRedeemer } from "../src/auth/preauth";
import { SecretStore } from "../src/auth/keychain";
import { loadConfig } from "../src/config";
import type { DeviceIdentity } from "../src/types";

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
  receivedBodies: string[];
  receivedUrls: string[];
  responder: (body: string) => { status: number; body: string };
  close: () => Promise<void>;
}

function startMock(): Promise<MockServer> {
  const receivedBodies: string[] = [];
  const receivedUrls: string[] = [];
  let responder: MockServer["responder"] = () => ({
    status: 500,
    body: '{"error":"no responder set"}',
  });
  const server: Server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      receivedBodies.push(body);
      receivedUrls.push(req.url ?? "/");
      const r = responder(body);
      res.statusCode = r.status;
      res.setHeader("content-type", "application/json");
      res.end(r.body);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${addr.port}`;
      const handle: MockServer = {
        url,
        receivedBodies,
        receivedUrls,
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

describe("PreauthRedeemer", () => {
  let tmp: string;
  let mock: MockServer;
  let originalDataDir: string | undefined;
  let originalApiBase: string | undefined;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "jadapps-preauth-"));
    originalDataDir = process.env.JADAPPS_RUNNER_DATA_DIR;
    originalApiBase = process.env.JADAPPS_API_BASE;
    process.env.JADAPPS_RUNNER_DATA_DIR = tmp;
    mock = await startMock();
    process.env.JADAPPS_API_BASE = mock.url;
  });

  afterEach(async () => {
    if (originalDataDir === undefined) delete process.env.JADAPPS_RUNNER_DATA_DIR;
    else process.env.JADAPPS_RUNNER_DATA_DIR = originalDataDir;
    if (originalApiBase === undefined) delete process.env.JADAPPS_API_BASE;
    else process.env.JADAPPS_API_BASE = originalApiBase;
    await mock.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function makeRedeemer() {
    const cfg = loadConfig();
    const secrets = new SecretStore(cfg.dataDir);
    const api = new ApiClient(cfg.apiBase, noopLogger);
    const redeemer = new PreauthRedeemer({ cfg, secrets, api, log: noopLogger });
    return { redeemer, secrets, cfg };
  }

  it("redeems a valid preauth token and persists pairing.json + refresh token", async () => {
    mock.responder = () => ({
      status: 200,
      body: JSON.stringify({
        deviceId: "dev-xyz",
        userId: "user-7",
        refreshToken: "rt-secret-abc",
      }),
    });

    const { redeemer, secrets, cfg } = makeRedeemer();
    expect(redeemer.isPaired()).toBe(false);

    const identity = await redeemer.redeem("PRE-TOKEN", {
      deviceName: "alice-laptop",
      platformTag: "win32-msix",
    });

    expect(identity.deviceId).toBe("dev-xyz");
    expect(identity.userId).toBe("user-7");
    expect(identity.apiBase).toBe(mock.url);
    expect(identity.pubKey).toMatch(/BEGIN PUBLIC KEY/);
    expect(identity.privKey).toMatch(/BEGIN PRIVATE KEY/);

    // pairing.json on disk
    const pairingPath = join(cfg.dataDir, "pairing.json");
    expect(existsSync(pairingPath)).toBe(true);
    const persisted = JSON.parse(readFileSync(pairingPath, "utf8")) as DeviceIdentity;
    expect(persisted.deviceId).toBe("dev-xyz");
    expect(redeemer.isPaired()).toBe(true);

    // Refresh token in keychain (or fallback file)
    const stored = await secrets.get("refresh_token");
    expect(stored).toBe("rt-secret-abc");
    const storedKey = await secrets.get("device_private_key");
    expect(storedKey).toBe(identity.privKey);

    // Wire-format check on the outgoing request
    expect(mock.receivedUrls[0]).toBe("/api/runner/pair/redeem");
    const sent = JSON.parse(mock.receivedBodies[0]!) as Record<string, string>;
    expect(sent.preauthToken).toBe("PRE-TOKEN");
    expect(sent.deviceName).toBe("alice-laptop");
    expect(sent.platform).toBe("win32-msix");
    expect(sent.publicKey).toMatch(/BEGIN PUBLIC KEY/);
  });

  it("refuses to redeem when already paired", async () => {
    const { redeemer, cfg } = makeRedeemer();
    writeFileSync(
      join(cfg.dataDir, "pairing.json"),
      JSON.stringify({ deviceId: "old", userId: "old" }),
      "utf8",
    );
    await expect(redeemer.redeem("any-token")).rejects.toThrow(/already paired/);
    // Server should not have been called
    expect(mock.receivedBodies).toHaveLength(0);
  });

  it("propagates server errors instead of swallowing them", async () => {
    mock.responder = () => ({
      status: 401,
      body: JSON.stringify({ error: "expired_preauth_token" }),
    });
    const { redeemer, cfg } = makeRedeemer();
    await expect(redeemer.redeem("expired")).rejects.toThrow();
    // No partial state should be written
    expect(existsSync(join(cfg.dataDir, "pairing.json"))).toBe(false);
  });

  it("rejects empty tokens before hitting the network", async () => {
    const { redeemer } = makeRedeemer();
    await expect(redeemer.redeem("")).rejects.toThrow(/required/);
    expect(mock.receivedBodies).toHaveLength(0);
  });
});
