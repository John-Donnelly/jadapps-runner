import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpDeps } from "./server.js";

/**
 * MCP resources for read-only AI-agent context. Three URIs:
 *   - jadapps://workflows/{id}     — full workflow JSON (graph + metadata)
 *   - jadapps://tools              — full tool catalogue
 *   - jadapps://credentials        — credential refs (no secrets)
 *
 * Resources serve the local cache; AI agents can subscribe to context
 * without round-tripping through tool calls.
 */
export function registerResources(server: McpServer, deps: McpDeps): void {
  server.registerResource(
    "tool-catalogue",
    "jadapps://tools",
    {
      title: "Tool catalogue",
      description: "Full list of tools the runner can execute, with metadata.",
      mimeType: "application/json",
    },
    async () => {
      const tools = await deps.catalogue.list().catch(() => []);
      return {
        contents: [
          {
            uri: "jadapps://tools",
            mimeType: "application/json",
            text: JSON.stringify(tools, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    "credentials",
    "jadapps://credentials",
    {
      title: "Credential refs",
      description: "Stored credential ref names + types (no secret values).",
      mimeType: "application/json",
    },
    async () => {
      const refs = deps.credentials.list().map((c) => ({
        ref: c.ref,
        type: c.type,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      }));
      return {
        contents: [
          {
            uri: "jadapps://credentials",
            mimeType: "application/json",
            text: JSON.stringify(refs, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    "workflow",
    new ResourceTemplate("jadapps://workflows/{id}", { list: undefined }),
    {
      title: "Workflow definition",
      description: "Workflow graph + sync metadata for a given workflow id.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const id = String(variables.id);
      const wf = deps.workflowStore.get(id);
      if (!wf) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify({ error: "not_found", id }),
            },
          ],
        };
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(wf, null, 2),
          },
        ],
      };
    },
  );
}
