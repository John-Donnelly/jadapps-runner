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
import { registerToolTools } from "./tools/tool.js";
import { registerWorkflowTools } from "./tools/workflow.js";
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
}

export const SERVER_INFO = {
  name: "jadapps-runner",
  version: "0.2.0",
} as const;

/**
 * Build a fresh McpServer with all JAD tools, resources, and prompts
 * registered. The server is transport-agnostic — `connect()` it to either a
 * StdioServerTransport (for `jadapps-runner mcp`) or an SSE/StreamableHTTP
 * transport (for the /mcp HTTP route).
 *
 * Each transport call creates its own server instance so concurrent stdio +
 * HTTP clients can't bleed state into each other.
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
  registerCredentialTools(server, deps);
  registerRunnerTools(server, deps);
  registerResources(server, deps);
  registerPrompts(server, deps);

  return server;
}
