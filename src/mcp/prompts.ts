import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpDeps } from "./server.js";

/**
 * Curated MCP prompts that guide the AI agent through common JAD workflows.
 * Prompts are richer than tools — they pre-load context (catalogue, examples)
 * and frame the conversation so the agent doesn't have to introspect the
 * surface from scratch.
 */
export function registerPrompts(server: McpServer, _deps: McpDeps): void {
  server.registerPrompt(
    "build_workflow",
    {
      title: "Build a workflow",
      description: "Guide the agent through assembling a multi-step workflow",
      argsSchema: {
        goal: z.string().describe("Plain-English description of what the workflow should do"),
      },
    },
    ({ goal }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `I want to build a JAD workflow that does the following:\n\n${goal}\n\n` +
              `Please:\n` +
              `1. Call \`tool_list\` to see what tools are available (filter by family if useful).\n` +
              `2. Sketch the graph as a JSON object: { nodes: [{id, toolSlug, position, config}], edges: [{source, target, sourcePort, targetPort}] }.\n` +
              `3. Call \`workflow_create\` with the graph.\n` +
              `4. If the user wants this to run on a schedule, call \`workflow_update\` to set scheduleCron.\n` +
              `5. Confirm by calling \`workflow_get\` and showing me the saved definition.\n\n` +
              `Remember: every node's \`toolSlug\` must exist in the catalogue, ports must be type-compatible, and the graph must be acyclic.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "tool_reference",
    {
      title: "Get tool reference",
      description: "Show all tools in a family with usage hints",
      argsSchema: {
        family: z
          .string()
          .describe("Family to inspect (csv, json, pdf, image, audio, video, connector, etc.)"),
      },
    },
    ({ family }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Show me every tool in the "${family}" family. ` +
              `For each tool include the slug, what it does, and what input/output ports it has. ` +
              `Use the \`tool_list\` MCP tool with family="${family}" to fetch the list, then format it as a markdown table.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "connector_setup",
    {
      title: "Set up a connector credential",
      description: "Walk the user through adding credentials for an external service",
      argsSchema: {
        service: z.string().describe("Service name (slack, airtable, postgres, etc.)"),
      },
    },
    ({ service }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `I want to use the ${service} connector. Please:\n\n` +
              `1. Tell me what credential type the connector needs (api_key / oauth2 / basic / custom) and which fields go in the data payload.\n` +
              `2. Tell me where to obtain the credential (which dashboard / docs page / scope).\n` +
              `3. Once I have the secret, guide me through calling \`credential_set\` with the right ref name, type, and data.\n` +
              `4. After saving, give me a one-line example call to \`tool_run\` that uses the new credential.\n\n` +
              `Use \`credential_list\` first to check whether the user already has a credential for this service.`,
          },
        },
      ],
    }),
  );
}
