import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpDeps } from "../server.js";

/**
 * MCP tools covering the workflow lifecycle — list, get, create, update,
 * delete, and run. Mutations land in the local store first, then sync to the
 * server in the background (sync triggers fire-and-forget after every save).
 *
 * Run results come back from the LocalWorkflowRunner. v0.1 supports linear
 * workflows; logic-node workflows surface a clear error directing the client
 * to the website orchestrator until the runner-side branching engine ships.
 */

const GraphSchema = z.object({
  nodes: z.array(z.unknown()),
  edges: z.array(z.unknown()),
});

export function registerWorkflowTools(server: McpServer, deps: McpDeps): void {
  server.registerTool(
    "workflow_list",
    {
      title: "List saved workflows",
      description:
        "List every workflow stored locally on the runner. Includes graph " +
        "summary (node count) and sync state (origin, serverSyncedAt).",
      inputSchema: {
        filter: z.enum(["all", "local", "server"]).optional().default("all"),
        limit: z.number().int().min(1).max(500).optional().default(100),
      },
    },
    async ({ filter, limit }) => {
      const all = deps.workflowStore.list();
      const filtered = (() => {
        switch (filter ?? "all") {
          case "local":
            return all.filter((w) => w.origin === "local");
          case "server":
            return all.filter((w) => w.origin === "server" || w.origin === "fork");
          default:
            return all;
        }
      })().slice(0, limit ?? 100);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              filtered.map((w) => ({
                id: w.id,
                name: w.name,
                description: w.description,
                origin: w.origin,
                isPrivate: w.isPrivate,
                scheduleCron: w.scheduleCron,
                nodeCount: (w.graph as { nodes?: unknown[] }).nodes?.length ?? 0,
                serverSyncedAt: w.serverSyncedAt,
                localUpdatedAt: w.localUpdatedAt,
              })),
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    "workflow_get",
    {
      title: "Get workflow graph",
      description: "Fetch a workflow's full graph (nodes + edges) and metadata.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const wf = deps.workflowStore.get(id);
      if (!wf) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Workflow not found: ${id}` }],
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(wf, null, 2) }],
      };
    },
  );

  server.registerTool(
    "workflow_create",
    {
      title: "Create a new workflow",
      description:
        "Create a new workflow draft. Saved locally with origin='local' and " +
        "isPrivate=true; a background sync uploads it to the server within seconds.",
      inputSchema: {
        name: z.string().min(1).max(120),
        description: z.string().max(2000).optional().default(""),
        graph: GraphSchema,
        scheduleCron: z.string().optional(),
      },
    },
    async ({ name, description, graph, scheduleCron }) => {
      const id = randomUUID();
      const wf = deps.workflowStore.upsert({
        id,
        name,
        description: description ?? null,
        graph: graph as Record<string, unknown>,
        serverSyncedAt: null,
        origin: "local",
        isPrivate: true,
        scheduleCron: scheduleCron ?? null,
      });
      // Background sync — fire and forget, errors are logged in the sync layer.
      void deps.workflowSync.sync().catch(() => undefined);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(wf, null, 2) }],
      };
    },
  );

  server.registerTool(
    "workflow_update",
    {
      title: "Update a workflow",
      description:
        "Patch a workflow's name/description/graph/cron. Local change syncs " +
        "to the server in the background.",
      inputSchema: {
        id: z.string(),
        patch: z
          .object({
            name: z.string().min(1).max(120).optional(),
            description: z.string().max(2000).optional(),
            graph: GraphSchema.optional(),
            scheduleCron: z.string().nullable().optional(),
            isPrivate: z.boolean().optional(),
          })
          .describe("Partial update — only specified fields are changed"),
      },
    },
    async ({ id, patch }) => {
      const existing = deps.workflowStore.get(id);
      if (!existing) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Workflow not found: ${id}` }],
        };
      }
      const wf = deps.workflowStore.upsert({
        id,
        name: patch.name ?? existing.name,
        description: patch.description ?? existing.description,
        graph: (patch.graph ?? existing.graph) as Record<string, unknown>,
        serverSyncedAt: existing.serverSyncedAt,
        origin: existing.origin,
        isPrivate: patch.isPrivate ?? existing.isPrivate,
        scheduleCron:
          patch.scheduleCron === undefined ? existing.scheduleCron : patch.scheduleCron,
      });
      void deps.workflowSync.sync().catch(() => undefined);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(wf, null, 2) }],
      };
    },
  );

  server.registerTool(
    "workflow_delete",
    {
      title: "Delete a workflow",
      description:
        "Remove a workflow from local storage. Note: server-side deletion is " +
        "manual today (delete via the website until tombstone sync ships).",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const ok = deps.workflowStore.delete(id);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ok }) }],
      };
    },
  );

  server.registerTool(
    "workflow_run",
    {
      title: "Run a saved workflow",
      description:
        "Execute a workflow stored locally. Uses the linear runner — for " +
        "branching/logic workflows, use the website orchestrator. Returns the " +
        "run summary + per-step trace.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const wf = deps.workflowStore.get(id);
      if (!wf) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Workflow not found: ${id}` }],
        };
      }
      const result = await deps.localWorkflowRunner.run(wf);
      return {
        isError: !result.ok,
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.registerTool(
    "workflow_sync",
    {
      title: "Trigger a workflow sync cycle",
      description:
        "Force a pull/push sync between the local store and the website's " +
        "workflows table. Returns counts of pulled/pushed records and any errors.",
      inputSchema: {},
    },
    async () => {
      const result = await deps.workflowSync.sync();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
