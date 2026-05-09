import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpDeps } from "../server.js";
import type { Credential } from "../../types.js";
import { getProbe, listProbeSlugs } from "../connector-probes.js";

/**
 * MCP tools for credential vault management. Important:
 *   - `credential_list` returns refs + metadata only — never plaintext values.
 *   - `credential_set` accepts the full credential payload but, by design,
 *     the AI agent should know only what type and which provider — the
 *     actual secret material can be supplied via the website's settings page
 *     or a CLI prompt the agent guides the user through.
 *   - `credential_delete` is destructive and irreversible.
 */
const CredTypeSchema = z.enum(["api_key", "oauth2", "basic", "custom"]);

export function registerCredentialTools(server: McpServer, deps: McpDeps): void {
  server.registerTool(
    "credential_list",
    {
      title: "List stored credentials",
      description:
        "List every credential ref stored on the runner. Returns ref + type + " +
        "timestamps; never returns plaintext secret values.",
      inputSchema: {},
    },
    async () => {
      const list = deps.credentials.list();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              list.map((c: Credential) => ({
                ref: c.ref,
                type: c.type,
                createdAt: c.createdAt,
                updatedAt: c.updatedAt,
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
    "credential_set",
    {
      title: "Store or update a credential",
      description:
        "Upsert a credential by ref. Data shape depends on type:\n" +
        '  api_key: { value: "sk-…" }\n' +
        '  oauth2: { accessToken: "…", refreshToken?: "…", instanceUrl?: "…", tenantId?: "…" }\n' +
        '  basic: { username: "…", password: "…" }\n' +
        '  custom: { /* arbitrary connector-specific fields */ }\n' +
        "Stored encrypted (AES-GCM) on the local SQLite vault. Never leaves the device.",
      inputSchema: {
        ref: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[a-zA-Z0-9_-]+$/)
          .describe("Credential reference name"),
        type: CredTypeSchema,
        data: z.record(z.unknown()).describe("Type-specific credential payload"),
      },
    },
    async ({ ref, type, data }) => {
      deps.credentials.upsert(ref, type, data);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ok: true, ref }) }],
      };
    },
  );

  server.registerTool(
    "credential_delete",
    {
      title: "Delete a credential",
      description: "Remove a credential by ref. Irreversible.",
      inputSchema: { ref: z.string() },
    },
    async ({ ref }) => {
      const ok = deps.credentials.delete(ref);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ok }) }],
      };
    },
  );

  server.registerTool(
    "credential_test",
    {
      title: "Probe a credential against a connector",
      description:
        "Verify a stored credential by making a lightweight read against " +
        "the connector (e.g. Slack auth.test, Stripe /v1/account, GitHub " +
        "/user, Notion /users/me). Returns ok + status + detail. The secret " +
        "value never leaves the runner — only the upstream API touches it.",
      inputSchema: {
        ref: z.string().describe("Credential ref name from credential_list"),
        connectorSlug: z
          .string()
          .describe("Connector slug to probe with (e.g. 'slack-postmessage', 'stripe', 'airtable')"),
      },
    },
    async ({ ref, connectorSlug }) => {
      const credential = deps.credentials.get(ref);
      if (!credential) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Credential not found: ${ref}` }],
        };
      }
      const probe = getProbe(connectorSlug);
      if (!probe) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  error: "no_probe",
                  message: `No probe registered for connector "${connectorSlug}".`,
                  supportedSlugs: listProbeSlugs(),
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      try {
        const result = await probe(credential);
        return {
          isError: !result.ok,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  ref,
                  connectorSlug,
                  ...result,
                },
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
}
