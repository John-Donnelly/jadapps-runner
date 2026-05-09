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

/**
 * Shape of a workflow_templates row as returned by the website's
 * /api/orchestrator/templates endpoint.
 */
export interface TemplateRow {
  id: string;
  workflow_id: string | null;
  slug: string;
  name: string;
  category: string | null;
  description: string | null;
  pseo_h1: string | null;
  pseo_meta_description: string | null;
  run_count: number;
  is_featured: boolean;
  published_at: string;
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
      familyLimits?: AccessToken["familyLimits"];
      streaming?: AccessToken["streaming"];
    };
    const out: AccessToken = {
      jwt: res.accessToken,
      expiresAt: res.expiresAt,
      sub: extractSubFromJwt(res.accessToken),
      tier: res.tier,
      limits: res.limits,
    };
    if (res.familyLimits) out.familyLimits = res.familyLimits;
    if (res.streaming) out.streaming = res.streaming;
    return out;
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

  /**
   * Workflow lifecycle methods — publish a draft, rollback to a prior
   * version, cancel/resume runs. All use Bearer access JWT.
   */
  async publishWorkflow(
    accessJwt: string,
    workflowId: string,
    comment?: string,
  ): Promise<{ versionId: string; versionNumber: number }> {
    const url = `${this.apiBase}/api/orchestrator/workflows/${encodeURIComponent(workflowId)}/publish`;
    const res = await this.bearerJson(url, "POST", accessJwt, comment ? { comment } : {});
    return (await res.body.json()) as { versionId: string; versionNumber: number };
  }

  async rollbackWorkflow(
    accessJwt: string,
    workflowId: string,
    versionId: string,
  ): Promise<{ rolledBackFrom: number; newVersionId: string; newVersionNumber: number }> {
    const url = `${this.apiBase}/api/orchestrator/workflows/${encodeURIComponent(workflowId)}/versions/${encodeURIComponent(versionId)}/rollback`;
    const res = await this.bearerJson(url, "POST", accessJwt, {});
    return (await res.body.json()) as {
      rolledBackFrom: number;
      newVersionId: string;
      newVersionNumber: number;
    };
  }

  async cancelRun(accessJwt: string, runId: string): Promise<{ ok: boolean; status: string }> {
    const url = `${this.apiBase}/api/orchestrator/runs/${encodeURIComponent(runId)}/cancel`;
    const res = await this.bearerJson(url, "POST", accessJwt, {});
    return (await res.body.json()) as { ok: boolean; status: string };
  }

  async resumeRun(
    accessJwt: string,
    runId: string,
  ): Promise<{ ok: boolean; status: string; resumeUrl: string }> {
    const url = `${this.apiBase}/api/orchestrator/runs/${encodeURIComponent(runId)}/resume`;
    const res = await this.bearerJson(url, "POST", accessJwt, {});
    return (await res.body.json()) as { ok: boolean; status: string; resumeUrl: string };
  }

  async getRunTrace(accessJwt: string, runId: string): Promise<unknown> {
    const url = `${this.apiBase}/api/orchestrator/runs/${encodeURIComponent(runId)}/trace`;
    const res = await this.bearerGet(url, accessJwt);
    return await res.body.json();
  }

  async enqueueWorkflow(
    accessJwt: string,
    workflowId: string,
    payload?: Record<string, unknown>,
  ): Promise<{ queueId: string; status: string }> {
    const url = `${this.apiBase}/api/orchestrator/workflows/${encodeURIComponent(workflowId)}/enqueue`;
    const res = await this.bearerJson(url, "POST", accessJwt, {
      source: "mcp",
      ...(payload ? { payload } : {}),
    });
    return (await res.body.json()) as { queueId: string; status: string };
  }

  /**
   * Workflow template CRUD. List + preview are unauthenticated; create /
   * update / delete require the caller's Bearer access JWT (and ownership
   * of the source workflow).
   */
  async listTemplates(
    accessJwt: string | null,
    query?: { q?: string; category?: string; featured?: boolean; limit?: number },
  ): Promise<TemplateRow[]> {
    const params = new URLSearchParams();
    if (query?.q) params.set("q", query.q);
    if (query?.category) params.set("category", query.category);
    if (query?.featured) params.set("featured", "true");
    if (query?.limit) params.set("limit", String(query.limit));
    const url = `${this.apiBase}/api/orchestrator/templates${params.size > 0 ? `?${params}` : ""}`;
    const headers: Record<string, string> = {};
    if (accessJwt) headers.authorization = `Bearer ${accessJwt}`;
    const res = await request(url, { method: "GET", headers });
    if (res.statusCode >= 300) {
      throw new ApiError(res.statusCode, await res.body.text());
    }
    const json = (await res.body.json()) as { templates: TemplateRow[] };
    return json.templates ?? [];
  }

  async getTemplate(
    accessJwt: string | null,
    idOrSlug: string,
  ): Promise<{ template: TemplateRow; graph: unknown }> {
    const url = `${this.apiBase}/api/orchestrator/templates/${encodeURIComponent(idOrSlug)}`;
    const headers: Record<string, string> = {};
    if (accessJwt) headers.authorization = `Bearer ${accessJwt}`;
    const res = await request(url, { method: "GET", headers });
    if (res.statusCode >= 300) {
      throw new ApiError(res.statusCode, await res.body.text());
    }
    return (await res.body.json()) as { template: TemplateRow; graph: unknown };
  }

  async createTemplate(
    accessJwt: string,
    body: {
      workflowId: string;
      slug: string;
      name: string;
      category?: string;
      description?: string;
      pseoH1?: string;
      pseoMetaDescription?: string;
      isFeatured?: boolean;
    },
  ): Promise<{ id: string; slug: string }> {
    const url = `${this.apiBase}/api/orchestrator/templates`;
    const res = await this.bearerJson(url, "POST", accessJwt, body);
    const json = (await res.body.json()) as { template?: { id: string; slug: string } };
    if (!json.template) throw new Error("createTemplate returned no template");
    return json.template;
  }

  async updateTemplate(
    accessJwt: string,
    idOrSlug: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    const url = `${this.apiBase}/api/orchestrator/templates/${encodeURIComponent(idOrSlug)}`;
    await this.bearerJson(url, "PATCH", accessJwt, patch);
  }

  async deleteTemplate(accessJwt: string, idOrSlug: string): Promise<void> {
    const url = `${this.apiBase}/api/orchestrator/templates/${encodeURIComponent(idOrSlug)}`;
    const res = await request(url, {
      method: "DELETE",
      headers: { authorization: `Bearer ${accessJwt}` },
    });
    if (res.statusCode >= 300) {
      throw new ApiError(res.statusCode, await res.body.text());
    }
  }

  /**
   * Webhook management. POST to /workflows/:id/webhooks creates a new
   * trigger and returns the secret + full URL ONCE — the caller must save
   * it.
   */
  async listWebhooks(accessJwt: string, workflowId: string): Promise<unknown[]> {
    const url = `${this.apiBase}/api/orchestrator/workflows/${encodeURIComponent(workflowId)}/webhooks`;
    const res = await this.bearerGet(url, accessJwt);
    const json = (await res.body.json()) as { webhooks: unknown[] };
    return json.webhooks ?? [];
  }

  async createWebhook(
    accessJwt: string,
    workflowId: string,
    description?: string,
  ): Promise<{ id: string; slug: string; secret: string; url: string }> {
    const url = `${this.apiBase}/api/orchestrator/workflows/${encodeURIComponent(workflowId)}/webhooks`;
    const res = await this.bearerJson(
      url,
      "POST",
      accessJwt,
      description ? { description } : {},
    );
    return (await res.body.json()) as {
      id: string;
      slug: string;
      secret: string;
      url: string;
    };
  }

  /**
   * Set or clear the cron schedule on a workflow. Reuses the existing
   * /workflows/:id PATCH endpoint with just schedule_cron in the body.
   * Pass null to clear the schedule.
   */
  async setCron(
    accessJwt: string,
    workflowId: string,
    cron: string | null,
  ): Promise<void> {
    await this.patchServerWorkflow(accessJwt, workflowId, {
      schedule_cron: cron,
    });
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

/**
 * Pull the `sub` claim out of a JWT without verifying its signature. The
 * runner only uses this for the concurrency-semaphore key — the website
 * already verified the JWT before issuing it back, and a bad sub here just
 * collides keys (worst case: one user's runs share a slot with another
 * paired user's, which can't happen because the runner is single-user).
 */
function extractSubFromJwt(jwt: string): string {
  const parts = jwt.split(".");
  if (parts.length < 2) return "anonymous";
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1]!, "base64url").toString("utf8"),
    ) as { sub?: unknown };
    return typeof payload.sub === "string" ? payload.sub : "anonymous";
  } catch {
    return "anonymous";
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
