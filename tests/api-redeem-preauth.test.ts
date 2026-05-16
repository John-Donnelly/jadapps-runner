import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ApiClient, ApiError } from "../src/api/client";

const noopLogger = {
  child: () => noopLogger,
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
} as unknown as ConstructorParameters<typeof ApiClient>[1];

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function startMockServer(
  handler: (req: IncomingMessage, body: string) => { status: number; body: string },
): Promise<{
  url: string;
  captured: CapturedRequest[];
  close: () => Promise<void>;
}> {
  const captured: CapturedRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      captured.push({
        url: req.url ?? "/",
        method: req.method ?? "GET",
        headers: req.headers as Record<string, string | string[] | undefined>,
        body,
      });
      const result = handler(req, body);
      res.statusCode = result.status;
      res.setHeader("content-type", "application/json");
      res.end(result.body);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        captured,
        close: () =>
          new Promise<void>((closeResolve) => server.close(() => closeResolve())),
      });
    });
  });
}

describe("ApiClient.redeemPreauth", () => {
  let mock: Awaited<ReturnType<typeof startMockServer>>;

  afterEach(async () => {
    if (mock) await mock.close();
  });

  it("posts the preauth payload and returns the device identity", async () => {
    mock = await startMockServer((req, _body) => {
      if (req.url === "/api/runner/pair/redeem" && req.method === "POST") {
        return {
          status: 200,
          body: JSON.stringify({
            deviceId: "dev-abc-123",
            userId: "user-42",
            refreshToken: "rt-xyz",
          }),
        };
      }
      return { status: 404, body: "{}" };
    });
    const api = new ApiClient(mock.url, noopLogger);
    const result = await api.redeemPreauth({
      preauthToken: "PRE-TOKEN-1",
      publicKey: "-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----",
      deviceName: "test-device",
      platform: "win32-tauri",
    });
    expect(result).toEqual({
      deviceId: "dev-abc-123",
      userId: "user-42",
      refreshToken: "rt-xyz",
    });
    expect(mock.captured).toHaveLength(1);
    const captured = mock.captured[0]!;
    expect(captured.url).toBe("/api/runner/pair/redeem");
    expect(captured.method).toBe("POST");
    expect(captured.headers["content-type"]).toBe("application/json");
    const sent = JSON.parse(captured.body) as Record<string, string>;
    expect(sent).toEqual({
      preauthToken: "PRE-TOKEN-1",
      publicKey: "-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----",
      deviceName: "test-device",
      platform: "win32-tauri",
    });
  });

  it("throws ApiError on HTTP errors", async () => {
    mock = await startMockServer(() => ({
      status: 401,
      body: JSON.stringify({ error: "invalid_preauth_token" }),
    }));
    const api = new ApiClient(mock.url, noopLogger);
    await expect(
      api.redeemPreauth({
        preauthToken: "expired",
        publicKey: "k",
        deviceName: "d",
        platform: "linux",
      }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it("throws when the server returns an incomplete payload", async () => {
    mock = await startMockServer(() => ({
      status: 200,
      body: JSON.stringify({ deviceId: "dev-1", userId: "" }),
    }));
    const api = new ApiClient(mock.url, noopLogger);
    await expect(
      api.redeemPreauth({
        preauthToken: "t",
        publicKey: "k",
        deviceName: "d",
        platform: "darwin",
      }),
    ).rejects.toThrow(/incomplete payload/);
  });
});
