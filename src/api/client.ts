import { request } from "undici";
import { signWithDeviceKey } from "../auth/keypair.js";
import type { AccessToken, RunToken, StepDescriptor, StepResult, TelemetryEvent } from "../types.js";
import type { Logger } from "../log.js";

interface BeginPairInput {
  pendingId: string;
  publicKey: string;
  code: string;
  deviceName: string;
  apiBase: string;
}

interface PollPairResult {
  confirmed: boolean;
  deviceId: string;
  userId: string;
  refreshToken: string;
}

export class ApiClient {
  constructor(
    private readonly apiBase: string,
    private readonly log: Logger,
  ) {}

  async beginPair(input: BeginPairInput): Promise<{ deepLink: string }> {
    const res = await this.post("/api/runner/pair/begin", {
      pendingId: input.pendingId,
      publicKey: input.publicKey,
      code: input.code,
      deviceName: input.deviceName,
    });
    return res as { deepLink: string };
  }

  async pollPair(pendingId: string): Promise<PollPairResult> {
    try {
      const res = await this.post("/api/runner/pair/poll", { pendingId });
      return res as PollPairResult;
    } catch (err) {
      this.log.debug({ err }, "pair poll failed; will retry");
      return { confirmed: false, deviceId: "", userId: "", refreshToken: "" };
    }
  }

  async exchangeToken(
    refreshToken: string,
    deviceId: string,
    privateKeyPem: string,
  ): Promise<AccessToken> {
    const ts = Date.now().toString();
    const challenge = `${deviceId}.${ts}`;
    const signature = signWithDeviceKey(privateKeyPem, challenge);
    const res = (await this.post("/api/runner/token", {
      refreshToken,
      deviceId,
      ts,
      signature,
    })) as {
      accessToken: string;
      expiresAt: number;
      tier: AccessToken["tier"];
      limits: AccessToken["limits"];
    };
    return {
      jwt: res.accessToken,
      expiresAt: res.expiresAt,
      tier: res.tier,
      limits: res.limits,
    };
  }

  async preflight(
    accessJwt: string,
    workflowId: string,
    estimatedBytes: number,
  ): Promise<RunToken> {
    return (await this.post(
      "/api/orchestrator/runs/preflight",
      { workflowId, estimatedBytes },
      accessJwt,
    )) as RunToken;
  }

  async fetchBundle(bundleUrl: string, accessJwt: string): Promise<Buffer> {
    const res = await request(bundleUrl, {
      method: "GET",
      headers: { authorization: `Bearer ${accessJwt}` },
    });
    if (res.statusCode >= 300) {
      throw new Error(`bundle fetch failed: ${res.statusCode}`);
    }
    return Buffer.from(await res.body.arrayBuffer());
  }

  async postEvents(
    runId: string,
    events: TelemetryEvent[],
    runToken: string,
  ): Promise<{ revoked: boolean }> {
    return (await this.post(
      `/api/orchestrator/runs/${encodeURIComponent(runId)}/events`,
      { events },
      runToken,
    )) as { revoked: boolean };
  }

  async finalizeRun(
    runId: string,
    runToken: string,
    result: { steps: StepResult[]; durationMs: number; bytesProcessed: number },
  ): Promise<void> {
    await this.post(
      `/api/orchestrator/runs/${encodeURIComponent(runId)}/finalize`,
      result,
      runToken,
    );
  }

  /** Server-mediated execution path (runner-via-server). */
  async executeServerSide(step: StepDescriptor, runToken: string): Promise<StepResult> {
    return (await this.post("/api/orchestrator/steps/execute", step, runToken)) as StepResult;
  }

  private async post(path: string, body: unknown, bearer?: string): Promise<unknown> {
    const url = path.startsWith("http") ? path : `${this.apiBase}${path}`;
    const res = await request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await res.body.text();
    if (res.statusCode >= 300) {
      throw new ApiError(res.statusCode, text);
    }
    return text ? JSON.parse(text) : {};
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public bodyText: string,
  ) {
    super(`api error ${status}: ${bodyText}`);
  }
}
