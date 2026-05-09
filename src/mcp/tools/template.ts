import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpDeps } from "../server.js";

/**
 * Workflow template MCP tools. Templates are the agent's primary discovery
 * surface — `template_search` lets an AI agent find relevant starting
 * points, `template_preview` shows the graph before instantiating, and
 * `workflow_from_template` clones the graph into a new local + server
 * draft the agent can then iterate on.
 *
 * `template_create` lets agents save useful workflows back to the
 * catalogue for future reuse — completing the discover → build → publish
 * loop entirely from MCP.
 */
export function registerTemplateTools(server: McpServer, deps: McpDeps): void {
  server.registerTool(
    "template_list",
    {
      title: "List workflow templates",
      description:
        "Browse the public catalogue of workflow templates. Sort order is " +
        "featured first, then run count, then publish date. Use `category` " +
        "to narrow by area (csv, media, ai, crm, etc.).",
      inputSchema: {
        category: z.string().max(60).optional(),
        featured: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).optional().default(50),
      },
    },
    async ({ category, featured, limit }) => {
      try {
        const access = await deps.tokens.getAccessToken().catch(() => null);
        const query: Parameters<typeof deps.api.listTemplates>[1] = {};
        if (category !== undefined) query.category = category;
        if (featured !== undefined) query.featured = featured;
        if (limit !== undefined) query.limit = limit;
        const templates = await deps.api.listTemplates(access?.jwt ?? null, query);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(templates, null, 2) }],
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
    "template_search",
    {
      title: "Search workflow templates",
      description:
        "Substring search over template names. Returns the same shape as " +
        "template_list but filtered by `q`.",
      inputSchema: {
        q: z.string().min(1).describe("Substring to match against template names"),
        category: z.string().max(60).optional(),
        limit: z.number().int().min(1).max(200).optional().default(20),
      },
    },
    async ({ q, category, limit }) => {
      try {
        const access = await deps.tokens.getAccessToken().catch(() => null);
        const query: Parameters<typeof deps.api.listTemplates>[1] = { q };
        if (category !== undefined) query.category = category;
        if (limit !== undefined) query.limit = limit;
        const templates = await deps.api.listTemplates(access?.jwt ?? null, query);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(templates, null, 2) }],
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
    "template_preview",
    {
      title: "Preview a template's graph",
      description:
        "Fetch a template's metadata + the source workflow's graph without " +
        "instantiating. Use the slug or the template id; slug is friendlier " +
        "for AI agents that found the template via search.",
      inputSchema: {
        idOrSlug: z.string().describe("Template UUID or slug"),
      },
    },
    async ({ idOrSlug }) => {
      try {
        const access = await deps.tokens.getAccessToken().catch(() => null);
        const result = await deps.api.getTemplate(access?.jwt ?? null, idOrSlug);
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
    "workflow_from_template",
    {
      title: "Instantiate a template as a new workflow",
      description:
        "Clone a template's graph into a new private workflow draft. " +
        "Optionally override the name (defaults to the template name). " +
        "The new workflow is saved locally and synced to the server in the " +
        "background.",
      inputSchema: {
        idOrSlug: z.string().describe("Template UUID or slug"),
        name: z.string().min(1).max(120).optional().describe("Override workflow name"),
        scheduleCron: z.string().optional().describe("Optional cron schedule"),
      },
    },
    async ({ idOrSlug, name, scheduleCron }) => {
      try {
        const access = await deps.tokens.getAccessToken().catch(() => null);
        const { template, graph } = await deps.api.getTemplate(access?.jwt ?? null, idOrSlug);
        if (!graph) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `Template "${idOrSlug}" has no source graph (workflow may have been deleted).`,
              },
            ],
          };
        }

        const id = randomUUID();
        const wf = deps.workflowStore.upsert({
          id,
          name: name ?? template.name,
          description: template.description ?? null,
          graph: graph as Record<string, unknown>,
          serverSyncedAt: null,
          origin: "local",
          isPrivate: true,
          scheduleCron: scheduleCron ?? null,
        });
        void deps.workflowSync.sync().catch(() => undefined);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ok: true, sourceTemplate: template.slug, workflow: wf },
                null,
                2,
              ),
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

  server.registerTool(
    "template_create",
    {
      title: "Save a workflow as a template",
      description:
        "Promote one of the user's workflows into the public template " +
        "catalogue. Requires the workflow already exists on the server (run " +
        "workflow_create first if needed). Slug must be kebab-case and unique.",
      inputSchema: {
        workflowId: z.string(),
        slug: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[a-z0-9-]+$/, "slug must be kebab-case"),
        name: z.string().min(1).max(120),
        category: z.string().max(60).optional(),
        description: z.string().max(2000).optional(),
        pseoH1: z.string().max(120).optional(),
        pseoMetaDescription: z.string().max(280).optional(),
        isFeatured: z.boolean().optional().default(false),
      },
    },
    async (args) => {
      try {
        const access = await deps.tokens.getAccessToken();
        const result = await deps.api.createTemplate(access.jwt, {
          workflowId: args.workflowId,
          slug: args.slug,
          name: args.name,
          ...(args.category !== undefined ? { category: args.category } : {}),
          ...(args.description !== undefined ? { description: args.description } : {}),
          ...(args.pseoH1 !== undefined ? { pseoH1: args.pseoH1 } : {}),
          ...(args.pseoMetaDescription !== undefined
            ? { pseoMetaDescription: args.pseoMetaDescription }
            : {}),
          ...(args.isFeatured !== undefined ? { isFeatured: args.isFeatured } : {}),
        });
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
    "template_update",
    {
      title: "Update template metadata",
      description: "Edit the name, category, description, or featured flag.",
      inputSchema: {
        idOrSlug: z.string(),
        patch: z.object({
          name: z.string().min(1).max(120).optional(),
          category: z.string().max(60).optional(),
          description: z.string().max(2000).optional(),
          pseoH1: z.string().max(120).optional(),
          pseoMetaDescription: z.string().max(280).optional(),
          isFeatured: z.boolean().optional(),
        }),
      },
    },
    async ({ idOrSlug, patch }) => {
      try {
        const access = await deps.tokens.getAccessToken();
        await deps.api.updateTemplate(access.jwt, idOrSlug, patch);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }],
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
    "template_delete",
    {
      title: "Delete a workflow template",
      description: "Remove a template from the catalogue. Owner-only.",
      inputSchema: { idOrSlug: z.string() },
    },
    async ({ idOrSlug }) => {
      try {
        const access = await deps.tokens.getAccessToken();
        await deps.api.deleteTemplate(access.jwt, idOrSlug);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }],
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
