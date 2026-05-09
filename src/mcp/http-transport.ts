import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FastifyInstance } from "fastify";
import { checkMcpLicense, createMcpServer, type McpDeps } from "./server.js";

/**
 * Mount the MCP server on the existing Fastify HTTP server at /mcp. Uses the
 * Streamable HTTP transport in stateless mode — every request gets a fresh
 * McpServer + Transport pair. Stateless is fine for AI agent interactions
 * because tools/list and tools/call are idempotent; long-running operations
 * (workflow_run streaming) are a follow-up that needs session persistence.
 *
 * Auth is handled by the existing onRequest hook in routes.ts which checks
 * the Bearer pairing token before any /v1/* or /mcp request reaches us.
 *
 * Important: bind path is /mcp (NOT /v1/mcp) so SDK clients with default
 * paths just work. The Fastify host is already 127.0.0.1, so this surface
 * is never reachable from the public internet.
 */
export async function mountMcpHttp(app: FastifyInstance, deps: McpDeps): Promise<void> {
  app.post("/mcp", async (req, reply) => {
    // Phase 11 license gate. Refuse without a Developer/Enterprise license
    // BEFORE constructing the McpServer so privileged tool registration
    // doesn't run. The HTTP body is JSON the SDK clients can surface.
    const lic = await checkMcpLicense(deps);
    if (!lic.ok) {
      reply.code(403).send({
        error: "license_required",
        message: lic.reason,
        upgrade_url: lic.upgradeUrl,
      });
      return;
    }

    // Omit sessionIdGenerator to opt into stateless mode per the SDK contract.
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    const server = createMcpServer(deps);
    // SDK transport types use optional callbacks; the connect() signature
    // declares them required. Cast through unknown to bridge the gap —
    // the SDK populates the callbacks itself when connect is called.
    await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);

    // Fastify wraps Node's IncomingMessage; the transport needs the raw
    // socket-level objects to write SSE / chunked responses.
    try {
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (err) {
      deps.log.error({ err }, "MCP request handler threw");
      if (!reply.raw.headersSent) {
        reply.raw.statusCode = 500;
        reply.raw.end(JSON.stringify({ error: "mcp_internal_error" }));
      }
    }

    // Tell Fastify we've handled the response directly.
    return reply.hijack();
  });

  // GET /mcp returns a small status payload so curl-style probes don't get
  // a confusing method-not-allowed; the actual MCP handshake is POST.
  app.get("/mcp", async () => ({
    name: "jadapps-runner-mcp",
    transport: "streamable-http",
    note: "POST JSON-RPC messages here. See https://modelcontextprotocol.io for the wire format.",
  }));
}
