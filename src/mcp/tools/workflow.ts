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
 *
 * GraphSchema normalises LLM-natural shapes into the canonical
 * `lib/orchestrator/types.ts:WorkflowGraph` the dashboard canvas expects.
 * The previous schema accepted `z.unknown()` which let agents save graphs
 * the UI couldn't load (e.g. `{nodes:[{id:"csv-cleaner",name:"Clean"}],
 * edges:[{from,to}]}`). Now we accept those shapes AS INPUT but rewrite to
 * canonical before persisting.
 */

interface CanonicalNode {
  id: string;
  toolSlug: string;
  position: { x: number; y: number };
  config: Record<string, unknown>;
  label?: string;
  category?: string;
  errorPolicy?: "abort" | "retry" | "skip";
  logicKind?: string;
}

interface CanonicalEdge {
  id: string;
  source: string;
  target: string;
  sourcePort: string;
  targetPort: string;
  type?: string;
}

interface CanonicalGraph {
  nodes: CanonicalNode[];
  edges: CanonicalEdge[];
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function pickObject(
  obj: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
  }
  return undefined;
}

/**
 * Map a loose LLM-supplied node into the canonical shape.
 *
 * Aliases accepted:
 *   - toolSlug ← `toolSlug` | `tool_slug` | `tool` | `slug`
 *   - id       ← `id` | `nodeId`  (auto-generated if missing)
 *   - config   ← `config` | `options` | `inputs` | `args`  (defaults `{}`)
 *   - label    ← `label` | `name` | `title`
 *
 * Position auto-fills to a horizontal layout when missing — agents rarely
 * know good coordinates, and the canvas is happy to load any valid pair.
 */
export function normalizeNode(loose: unknown, index: number): CanonicalNode {
  if (typeof loose !== "object" || loose === null || Array.isArray(loose)) {
    throw new Error(`node at index ${index} is not an object`);
  }
  const n = loose as Record<string, unknown>;
  const toolSlug = pickString(n, ["toolSlug", "tool_slug", "tool", "slug"]);
  if (!toolSlug) {
    throw new Error(
      `node at index ${index} is missing toolSlug. ` +
        `Each node must reference a tool by slug from tool_list ` +
        `(aliases accepted: tool, slug). Saw keys: ${Object.keys(n).join(", ")}`,
    );
  }
  const id = pickString(n, ["id", "nodeId"]) ?? `n_${randomUUID().slice(0, 8)}`;
  const posRaw = pickObject(n, ["position", "pos"]);
  const position =
    posRaw && typeof posRaw.x === "number" && typeof posRaw.y === "number"
      ? { x: posRaw.x as number, y: posRaw.y as number }
      : { x: 200 + index * 240, y: 200 };
  const config = (pickObject(n, ["config", "options", "inputs", "args"]) ??
    {}) as Record<string, unknown>;
  const out: CanonicalNode = { id, toolSlug, position, config };
  const label = pickString(n, ["label", "name", "title"]);
  if (label) out.label = label;
  const category = pickString(n, ["category"]);
  if (category) out.category = category;
  const errorPolicy = pickString(n, ["errorPolicy", "error_policy"]);
  if (errorPolicy === "abort" || errorPolicy === "retry" || errorPolicy === "skip") {
    out.errorPolicy = errorPolicy;
  }
  const logicKind = pickString(n, ["logicKind", "logic_kind"]);
  if (logicKind) out.logicKind = logicKind;
  return out;
}

/**
 * Map a loose LLM-supplied edge into the canonical shape.
 *
 * Aliases accepted:
 *   - source     ← `source` | `from` | `src`
 *   - target     ← `target` | `to`   | `dst`
 *   - sourcePort ← `sourcePort` | `source_port` | `outputPort`  (defaults "")
 *   - targetPort ← `targetPort` | `target_port` | `inputPort`   (defaults "")
 */
export function normalizeEdge(loose: unknown, index: number): CanonicalEdge {
  if (typeof loose !== "object" || loose === null || Array.isArray(loose)) {
    throw new Error(`edge at index ${index} is not an object`);
  }
  const e = loose as Record<string, unknown>;
  const source = pickString(e, ["source", "from", "src"]);
  const target = pickString(e, ["target", "to", "dst"]);
  if (!source || !target) {
    throw new Error(
      `edge at index ${index} missing source/target. ` +
        `Each edge needs source and target node ids ` +
        `(aliases accepted: from/to). Saw keys: ${Object.keys(e).join(", ")}`,
    );
  }
  const out: CanonicalEdge = {
    id: pickString(e, ["id"]) ?? `e_${randomUUID().slice(0, 8)}`,
    source,
    target,
    sourcePort: pickString(e, ["sourcePort", "source_port", "outputPort"]) ?? "",
    targetPort: pickString(e, ["targetPort", "target_port", "inputPort"]) ?? "",
  };
  const t = pickString(e, ["type"]);
  if (t) out.type = t;
  return out;
}

/**
 * Top-level graph normaliser. Accepts the loose shape from
 * `GraphSchema.parse(input)` (untyped arrays of objects) and returns the
 * canonical graph the dashboard's orchestrator expects.
 *
 * On any node/edge that can't be normalised, throws with a useful message
 * pointing at exactly which entry and which field was the problem — the
 * MCP layer surfaces that as a tool-call error rather than persisting a
 * graph the UI can't load.
 */
export function normalizeGraph(loose: { nodes: unknown[]; edges: unknown[] }): CanonicalGraph {
  return {
    nodes: loose.nodes.map((n, i) => normalizeNode(n, i)),
    edges: loose.edges.map((e, i) => normalizeEdge(e, i)),
  };
}

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
        "Create a new workflow draft. Saved locally; a background sync uploads " +
        "it to the server within seconds so the dashboard canvas can open it.\n\n" +
        "Graph shape (the dashboard renders this on a canvas — supply the FIELDS " +
        "below, not arbitrary JSON):\n\n" +
        "  nodes: [\n" +
        "    {\n" +
        "      toolSlug:  '<slug from tool_list>',          // REQUIRED\n" +
        "      id:        '<unique within workflow>',       // optional, auto-generated\n" +
        "      position:  { x: 200, y: 200 },               // optional, auto-laid-out\n" +
        "      config:    { ...per-tool options },          // optional, default {}\n" +
        "    }\n" +
        "  ]\n" +
        "  edges: [\n" +
        "    {\n" +
        "      source:      '<source node id>',             // REQUIRED\n" +
        "      target:      '<target node id>',             // REQUIRED\n" +
        "      sourcePort:  '<source output port name>',    // optional, default ''\n" +
        "      targetPort:  '<target input port name>',     // optional, default ''\n" +
        "      id:          '<unique within workflow>',     // optional, auto-generated\n" +
        "    }\n" +
        "  ]\n\n" +
        "Aliases tolerated: 'tool'/'slug' → toolSlug; 'from'/'to' → source/target.\n\n" +
        "Worked example — clean a CSV and convert it to JSON:\n" +
        "{\n" +
        '  "name": "CSV → JSON",\n' +
        '  "graph": {\n' +
        '    "nodes": [\n' +
        '      { "id": "n1", "toolSlug": "csv-cleaner" },\n' +
        '      { "id": "n2", "toolSlug": "csv-to-json" }\n' +
        "    ],\n" +
        '    "edges": [ { "source": "n1", "target": "n2" } ]\n' +
        "  }\n" +
        "}",
      inputSchema: {
        name: z.string().min(1).max(120),
        description: z.string().max(2000).optional().default(""),
        graph: GraphSchema,
        scheduleCron: z.string().optional(),
      },
    },
    async ({ name, description, graph, scheduleCron }) => {
      let normalized: CanonicalGraph;
      try {
        normalized = normalizeGraph(graph);
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: (err as Error).message }],
        };
      }
      const id = randomUUID();
      const wf = deps.workflowStore.upsert({
        id,
        name,
        description: description ?? null,
        graph: normalized as unknown as Record<string, unknown>,
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
      let nextGraph: unknown = existing.graph;
      if (patch.graph !== undefined) {
        try {
          nextGraph = normalizeGraph(patch.graph);
        } catch (err) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: (err as Error).message }],
          };
        }
      }
      const wf = deps.workflowStore.upsert({
        id,
        name: patch.name ?? existing.name,
        description: patch.description ?? existing.description,
        graph: nextGraph as Record<string, unknown>,
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
        "run summary + per-step trace. When the caller supplies a " +
        "progressToken in the tool call's _meta, per-step progress " +
        "notifications are emitted as the run proceeds.",
      inputSchema: { id: z.string() },
    },
    async ({ id }, extra) => {
      const wf = deps.workflowStore.get(id);
      if (!wf) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Workflow not found: ${id}` }],
        };
      }

      // Phase 5i rate limit — keyed on the access-token sub so a single
      // AI agent looping workflow_run hits 10/hr and gets clean backoff
      // info instead of slowly draining the queue.
      let access;
      try {
        access = await deps.tokens.getAccessToken();
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Runner unpaired: ${(err as Error).message}`,
            },
          ],
        };
      }
      const { WORKFLOW_RUN_LIMIT, WORKFLOW_RUN_WINDOW_MS } = await import(
        "../../runtime/rate-limit.js"
      );
      const rl = deps.rateLimiter.check(
        `workflow_run:${access.sub}`,
        WORKFLOW_RUN_LIMIT,
        WORKFLOW_RUN_WINDOW_MS,
      );
      if (!rl.ok) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  error: "rate_limited",
                  message: `workflow_run capped at ${WORKFLOW_RUN_LIMIT}/hour. Retry in ${Math.ceil(rl.retryAfterMs / 1000)}s.`,
                  retryAfterMs: rl.retryAfterMs,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      // If the client supplied a progressToken on the request, emit
      // notifications/progress per finished step. Without a token MCP
      // requires the server to skip progress notifications.
      const progressToken = extra?._meta?.progressToken;
      const onStepCallback = progressToken
        ? (info: {
            stepIndex: number;
            totalSteps: number;
            nodeId: string;
            toolSlug: string;
            status: "done" | "error" | "skipped";
            durationMs: number;
          }) => {
            void extra
              .sendNotification({
                method: "notifications/progress",
                params: {
                  progressToken,
                  progress: info.stepIndex + 1,
                  total: info.totalSteps,
                  message: `${info.toolSlug} → ${info.status} (${info.durationMs}ms)`,
                },
              })
              .catch(() => undefined);
          }
        : undefined;

      const result = await deps.localWorkflowRunner.run(wf, [], onStepCallback);
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
