import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpDeps } from "../server.js";

/**
 * Workflow lifecycle MCP tools — publish, rollback, run-status, cancel,
 * resume, and triggered-run enqueue. All call into the website's
 * /api/orchestrator/* routes via ApiClient using the runner's Bearer
 * access JWT.
 */
export function registerLifecycleTools(server: McpServer, deps: McpDeps): void {
  server.registerTool(
    "workflow_publish",
    {
      title: "Publish a workflow draft",
      description:
        "Snapshot the current draft as an immutable workflow_versions row " +
        "and update workflows.published_version_id. Triggered runs (cron, " +
        "webhook, auto-dispatch) read from the published snapshot from now " +
        "on; the canvas keeps editing the draft.",
      inputSchema: {
        id: z.string(),
        comment: z.string().max(500).optional().describe("Optional release note"),
      },
    },
    async ({ id, comment }) => {
      try {
        const access = await deps.tokens.getAccessToken();
        const result = await deps.api.publishWorkflow(access.jwt, id, comment);
        // Trigger sync so the local store mirrors the new published version.
        void deps.workflowSync.sync().catch(() => undefined);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: (err as Error).message }],
        };
      }
    },
  );

  server.registerTool(
    "workflow_rollback",
    {
      title: "Roll back to a prior version",
      description:
        "Take the snapshot at versionId and republish it as a NEW version " +
        "(immutable history is preserved). Also overwrites the draft so the " +
        "canvas opens at the rolled-back state.",
      inputSchema: {
        id: z.string().describe("Workflow id"),
        versionId: z.string().describe("workflow_versions.id to roll back to"),
      },
    },
    async ({ id, versionId }) => {
      try {
        const access = await deps.tokens.getAccessToken();
        const result = await deps.api.rollbackWorkflow(access.jwt, id, versionId);
        void deps.workflowSync.sync().catch(() => undefined);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: (err as Error).message }],
        };
      }
    },
  );

  server.registerTool(
    "workflow_run_enqueue",
    {
      title: "Enqueue a saved workflow for execution",
      description:
        "Push a row into workflow_run_queue so the auto-dispatch poller " +
        "picks it up. Use this for fire-and-forget workflow runs that should " +
        "go through the full server-side dispatch path. For ad-hoc local-only " +
        "execution use workflow_run instead.",
      inputSchema: {
        id: z.string(),
        payload: z.record(z.unknown()).optional().describe("Optional input payload"),
      },
    },
    async ({ id, payload }) => {
      try {
        const access = await deps.tokens.getAccessToken();
        const result = await deps.api.enqueueWorkflow(access.jwt, id, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: (err as Error).message }],
        };
      }
    },
  );

  server.registerTool(
    "workflow_run_status",
    {
      title: "Get run status + step trace",
      description:
        "Fetch the trace of a workflow run (per-step durations, statuses, " +
        "outputs). Use after workflow_run / workflow_run_enqueue to monitor " +
        "progress.",
      inputSchema: { runId: z.string() },
    },
    async ({ runId }) => {
      try {
        const access = await deps.tokens.getAccessToken();
        const trace = await deps.api.getRunTrace(access.jwt, runId);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(trace, null, 2) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: (err as Error).message }],
        };
      }
    },
  );

  server.registerTool(
    "workflow_run_cancel",
    {
      title: "Cancel an in-progress run",
      description:
        "Mark a running/paused/queued run as cancelled. The runner's " +
        "dispatch poller checks the status on each step boundary and exits " +
        "early if it sees `cancelled`.",
      inputSchema: { runId: z.string() },
    },
    async ({ runId }) => {
      try {
        const access = await deps.tokens.getAccessToken();
        const result = await deps.api.cancelRun(access.jwt, runId);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: (err as Error).message }],
        };
      }
    },
  );

  server.registerTool(
    "workflow_run_resume",
    {
      title: "Resume a paused workflow run",
      description:
        "Flip a paused run back to running so the orchestrator's resume " +
        "page (browser-side) can pick up from the pause point. Returns the " +
        "resumeUrl the user should open.",
      inputSchema: { runId: z.string() },
    },
    async ({ runId }) => {
      try {
        const access = await deps.tokens.getAccessToken();
        const result = await deps.api.resumeRun(access.jwt, runId);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: (err as Error).message }],
        };
      }
    },
  );
}
