import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpDeps } from "../server.js";

/**
 * Trigger MCP tools — webhook + cron management. Webhooks are the primary
 * way external systems fire workflows; cron is the primary way the runner
 * fires workflows on a schedule. Both surfaces are read/write so AI agents
 * can stand up an automation end-to-end.
 *
 * Webhook secret leaks: createWebhook returns the plaintext secret + URL
 * ONCE in the response. The runner should pass them straight through to
 * the user — there is no way to recover the secret afterwards (only the
 * SHA-256 hash is stored).
 */
export function registerTriggerTools(server: McpServer, deps: McpDeps): void {
  server.registerTool(
    "webhook_list",
    {
      title: "List webhooks for a workflow",
      description:
        "List every webhook trigger registered against a workflow. Returns " +
        "slug, active state, description, last-received timestamp, receive " +
        "count. Does NOT return secrets — those are only available at create " +
        "time.",
      inputSchema: { workflowId: z.string() },
    },
    async ({ workflowId }) => {
      try {
        const access = await deps.tokens.getAccessToken();
        const webhooks = await deps.api.listWebhooks(access.jwt, workflowId);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(webhooks, null, 2) }],
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
    "webhook_create",
    {
      title: "Create a webhook trigger",
      description:
        "Mint a new webhook for a workflow. Returns the secret + the full " +
        "POST URL — IMPORTANT: the secret is shown only once and cannot be " +
        "recovered later (we store only the SHA-256 hash). Pass the URL to " +
        "the calling system; it can POST any JSON body to fire the workflow.",
      inputSchema: {
        workflowId: z.string(),
        description: z.string().max(140).optional().describe("Human label"),
      },
    },
    async ({ workflowId, description }) => {
      try {
        const access = await deps.tokens.getAccessToken();
        const result = await deps.api.createWebhook(access.jwt, workflowId, description);
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
    "cron_set",
    {
      title: "Set or clear cron schedule on a workflow",
      description:
        "Set the cron expression that fires the workflow on a schedule, or " +
        "pass cron=null to clear it. Standard 5-field cron format: " +
        "`minute hour day-of-month month day-of-week`. Examples: " +
        '"0 9 * * 1" (Mondays 9am), "*/15 * * * *" (every 15 min), ' +
        '"0 0 1 * *" (1st of every month).',
      inputSchema: {
        workflowId: z.string(),
        cron: z
          .string()
          .nullable()
          .describe("Cron expression, or null to clear the schedule"),
      },
    },
    async ({ workflowId, cron }) => {
      try {
        const access = await deps.tokens.getAccessToken();
        await deps.api.setCron(access.jwt, workflowId, cron);
        // Trigger sync so the local store mirrors the new schedule.
        void deps.workflowSync.sync().catch(() => undefined);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ok: true, workflowId, cron }, null, 2),
            },
          ],
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
