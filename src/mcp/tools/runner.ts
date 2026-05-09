import { statfs } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpDeps } from "../server.js";

/**
 * Runner-status MCP tools — surfaces pairing/tier/disk/queue info to the AI
 * agent so it can reason about whether the runner is ready and what bandwidth
 * is available before issuing work.
 */
export function registerRunnerTools(server: McpServer, deps: McpDeps): void {
  server.registerTool(
    "runner_status",
    {
      title: "Get runner status",
      description:
        "Returns pairing state, tier, byte budget, scratch disk free space, " +
        "and tool catalogue size. Use to decide if the runner is ready before " +
        "calling tool_run or workflow_run.",
      inputSchema: {},
    },
    async () => {
      let access: Awaited<ReturnType<typeof deps.tokens.getAccessToken>> | null = null;
      try {
        access = await deps.tokens.getAccessToken();
      } catch {
        /* unpaired or offline */
      }

      let diskFree: number | null = null;
      let diskTotal: number | null = null;
      try {
        const st = await statfs(deps.scratch.basePath);
        diskFree = Number(st.bavail) * Number(st.bsize);
        diskTotal = Number(st.blocks) * Number(st.bsize);
      } catch {
        /* statfs unavailable */
      }

      const catalogue = await deps.catalogue.list().catch(() => []);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                paired: access !== null,
                tier: access?.tier ?? null,
                limits: access?.limits ?? null,
                disk: {
                  scratchDir: deps.scratch.basePath,
                  freeBytes: diskFree,
                  totalBytes: diskTotal,
                },
                toolCatalogueSize: catalogue.length,
                workflowCount: deps.workflowStore.list().length,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
