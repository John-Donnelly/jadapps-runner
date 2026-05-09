import { request } from "undici";
import { signWithDeviceKey } from "../auth/keypair.js";
import type {
  AccessToken,
  RunToken,
  Runtime,
  StepDescriptor,
  StepResult,
  Tier,
  TelemetryEvent,
} from "../types.js";
import type { Logger } from "../log.js";

export interface CatalogueEntry {
  slug: string;
  toolId: string;
  version: string;
  runtime: Runtime;
  tierRequired: Tier;
  bundleUrl: string;
  bundleSha256: string;
  encrypted: boolean;
}

/**
 * Shape of a workflow row as returned by the website's
 * /api/orchestrator/workflows endpoint. Mirrors the public.workflows columns
 * — only the subset we sync. updated_at is an ISO string.
 */
export interface RemoteWorkflowRow {
  id: string;
  user_id: string;
  name: string;
  description: string;
  graph: { nodes: unknown[]; edges: unknown[] };
  schedule_cron: string | null;
  visibility: "private" | "team";
  updated_at: string;
}

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
    steps: Array<{ stepIndex: number; toolId: string }>,
  ): Promise<RunToken> {
    const res = (await this.post(
      "/api/orchestrator/runs/preflight",
      { workflowId, estimatedBytes, steps },
      accessJwt,
    )) as {
      runId: string;
      jwt: string;
      byteBudget: number;
      expiresAt: number;
      allowedRuntimes: RunToken["allowedRuntimes"];
      tools: RunToken["tools"];
    };
    return {
      runId: res.runId,
      jwt: res.jwt,
      byteBudget: res.byteBudget,
      expiresAt: res.expiresAt,
      allowedRuntimes: res.allowedRuntimes,
      tools: res.tools,
    };
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

  /**
   * Fetch the runner-tool catalogue. Used to populate /v1/tools and resolve
   * bundle metadata for slug-based dispatch (POST /v1/tools/:slug/run).
   */
  async fetchToolCatalogue(accessJwt: string): Promise<{
    tools: CatalogueEntry[];
    generatedAt: number;
  }> {
    const url = `${this.apiBase}/api/runner/tools/catalogue`;
    const res = await request(url, {
      method: "GET",
      headers: { authorization: `Bearer ${accessJwt}` },
    });
    if (res.statusCode >= 300) {
      const text = await res.body.text();
      throw new ApiError(res.statusCode, text);
    }
    return (await res.body.json()) as { tools: CatalogueEntry[]; generatedAt: number };
  }

  /**
   * Workflow CRUD against the website's existing /api/orchestrator/workflows
   * routes. The runner's WorkflowSync uses these to pull server-side workflows
   * into local storage and push locally-created drafts up as private workflows.
   *
   * The website routes accept either a next-auth session (browser) or a
   * runner Bearer access JWT — see resolveUserEmail() in those routes.
   */
  async listServerWorkflows(accessJwt: string): Promise<RemoteWorkflowRow[]> {
    const url = `${this.apiBase}/api/orchestrator/workflows`;
    const res = await this.bearerGet(url, accessJwt);
    const json = (await res.body.json()) as { rows: RemoteWorkflowRow[] };
    return json.rows ?? [];
  }

  async createServerWorkflow(
    accessJwt: string,
    body: {
      name: string;
      description: string;
      graph: unknown;
      scheduleCron?: string | null;
      visibility?: "private" | "team";
    },
  ): Promise<{ id: string }> {
    const url = `${this.apiBase}/api/orchestrator/workflows`;
    const res = await this.bearerJson(url, "POST", accessJwt, body);
    const json = (await res.body.json()) as { workflow?: { id: string }; error?: string };
    if (!json.workflow) {
      throw new Error(json.error ?? "createServerWorkflow returned no workflow");
    }
    return json.workflow;
  }

  async patchServerWorkflow(
    accessJwt: string,
    id: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    const url = `${this.apiBase}/api/orchestrator/workflows/${encodeURIComponent(id)}`;
    await this.bearerJson(url, "PATCH", accessJwt, body);
  }

  async deleteServerWorkflow(accessJwt: string, id: string): Promise<void> {
    const url = `${this.apiBase}/api/orchestrator/workflows/${encodeURIComponent(id)}`;
    const res = await request(url, {
      method: "DELETE",
      headers: { authorization: `Bearer ${accessJwt}` },
    });
    if (res.statusCode >= 300) {
      const text = await res.body.text();
      throw new ApiError(res.statusCode, text);
    }
  }

  private async bearerGet(url: string, accessJwt: string) {
    const res = await request(url, {
      method: "GET",
      headers: { authorization: `Bearer ${accessJwt}` },
    });
    if (res.statusCode >= 300) {
      const text = await res.body.text();
      throw new ApiError(res.statusCode, text);
    }
    return res;
  }

  private async bearerJson(url: string, method: string, accessJwt: string, body: unknown) {
    const res = await request(url, {
      method,
      headers: {
        authorization: `Bearer ${accessJwt}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (res.statusCode >= 300) {
      const text = await res.body.text();
      throw new ApiError(res.statusCode, text);
    }
    return res;
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

  /**
   * Pause a hybrid run at the boundary between runner-bundled and
   * browser-only steps. Inline artifact (≤1MB after base64 decode)
   * carries the last successful step's output so the browser can
   * resume execution from `pausedAtStep + 1`.
   */
  async pauseRun(
    runId: string,
    runToken: string,
    body: {
      pausedAtStep: number;
      durationMs: number;
      bytesProcessed: number;
      artifact: { base64: string; mime: string; filename: string } | null;
    },
  ): Promise<void> {
    await this.post(
      `/api/orchestrator/runs/${encodeURIComponent(runId)}/pause`,
      body,
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
