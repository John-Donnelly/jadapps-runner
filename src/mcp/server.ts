import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Logger } from "../log.js";
import type { Executor } from "../runtime/executor.js";
import type { ToolCatalogue } from "../runtime/tool-catalogue.js";
import type { TokenManager } from "../auth/tokens.js";
import type { CredentialStore } from "../credentials/store.js";
import type { ScratchManager } from "../runtime/scratch.js";
import type { WorkflowStore } from "../workflows/store.js";
import type { WorkflowSync } from "../workflows/sync.js";
import type { LocalWorkflowRunner } from "../workflows/runner.js";
import type { ApiClient } from "../api/client.js";
import type { EventQueue } from "../telemetry/queue.js";
import type { ConcurrencyLimiter } from "../runtime/concurrency.js";
import type { RateLimiter } from "../runtime/rate-limit.js";
import type { LicenseManager } from "../auth/license.js";
import { registerToolTools } from "./tools/tool.js";
import { registerWorkflowTools } from "./tools/workflow.js";
import { registerLifecycleTools } from "./tools/lifecycle.js";
import { registerTemplateTools } from "./tools/template.js";
import { registerTriggerTools } from "./tools/trigger.js";
import { registerCredentialTools } from "./tools/credential.js";
import { registerRunnerTools } from "./tools/runner.js";
import { registerResources } from "./resources.js";
import { registerPrompts } from "./prompts.js";

export interface McpDeps {
  log: Logger;
  executor: Executor;
  catalogue: ToolCatalogue;
  tokens: TokenManager;
  credentials: CredentialStore;
  scratch: ScratchManager;
  workflowStore: WorkflowStore;
  workflowSync: WorkflowSync;
  localWorkflowRunner: LocalWorkflowRunner;
  api: ApiClient;
  eventQueue: EventQueue;
  concurrency: ConcurrencyLimiter;
  license: LicenseManager;
  rateLimiter: RateLimiter;
}

export const SERVER_INFO = {
  name: "jadapps-runner",
  version: "0.2.0",
} as const;

/**
 * Phase 11 license gate. Verifies the runner has an active Developer or
 * Enterprise license before letting MCP run. Used by both the stdio CLI
 * (`jadapps-runner mcp`) and the HTTP transport (`/mcp` POST handler).
 *
 * Returns:
 *   - `{ ok: true }` if a license token covering 'mcp' exists.
 *   - `{ ok: false, ... }` with the user-visible upgrade reason otherwise.
 *
 * Callers convert the failure into either an exit (stdio) or a 403 with a
 * readable JSON body (HTTP). Either way, no McpServer is constructed and
 * no privileged code runs.
 */
export async function checkMcpLicense(deps: McpDeps): Promise<
  | { ok: true }
  | { ok: false; reason: string; upgradeUrl: string }
> {
  const allowed = await deps.license.hasFeature("mcp");
  if (allowed) return { ok: true };
  const denial = deps.license.permanentDenialReason();
  return {
    ok: false,
    reason:
      denial?.reason ??
      "MCP requires a Developer or Enterprise license. Visit jadapps.app/pricing.",
    upgradeUrl: denial?.upgradeUrl ?? "https://jadapps.app/pricing",
  };
}

/**
 * Build a fresh McpServer with all JAD tools, resources, and prompts
 * registered. The server is transport-agnostic — `connect()` it to either a
 * StdioServerTransport (for `jadapps-runner mcp`) or an SSE/StreamableHTTP
 * transport (for the /mcp HTTP route).
 *
 * Each transport call creates its own server instance so concurrent stdio +
 * HTTP clients can't bleed state into each other.
 *
 * Callers should run `checkMcpLicense(deps)` first — this function does
 * NOT enforce the gate itself, so callers can shape the failure response
 * for their transport.
 */
export function createMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer(SERVER_INFO, {
    capabilities: {
      tools: {},
      resources: { subscribe: false, listChanged: false },
      prompts: { listChanged: false },
      logging: {},
    },
    instructions:
      "JAD Apps local automation runner. Exposes 200+ tools across CSV, JSON, " +
      "PDF, image, audio, video, and 30 API connectors plus full workflow " +
      "orchestration. Workflows execute locally; credentials never leave the " +
      "device. See https://jadapps.app for the full tool catalogue.",
  });

  registerToolTools(server, deps);
  registerWorkflowTools(server, deps);
  registerLifecycleTools(server, deps);
  registerTemplateTools(server, deps);
  registerTriggerTools(server, deps);
  registerCredentialTools(server, deps);
  registerRunnerTools(server, deps);
  registerResources(server, deps);
  registerPrompts(server, deps);

  return server;
}
