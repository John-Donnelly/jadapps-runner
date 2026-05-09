import { z } from "zod";
import { randomUUID } from "node:crypto";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpDeps } from "../server.js";
import type { FileRef, RunToken, StepDescriptor } from "../../types.js";
import {
  checkFamilyLimits,
  violationToHttpBody,
} from "../../runtime/tier-limits.js";

/**
 * MCP tools for direct tool dispatch — `tool_list` and `tool_run`.
 *
 * `tool_run` materialises base64 file inputs into the runner's scratch dir,
 * dispatches via the existing Executor, and returns either a base64-encoded
 * primary output (for small files) or a fileRef the caller can fetch later.
 *
 * Output cap: 4MB inline base64 — anything larger surfaces as a file ref the
 * MCP client can fetch via the runner's HTTP API. This keeps MCP responses
 * within typical client message size limits.
 */
const INLINE_OUTPUT_CAP = 4 * 1024 * 1024;

export function registerToolTools(server: McpServer, deps: McpDeps): void {
  server.registerTool(
    "tool_list",
    {
      title: "List available tools",
      description:
        "List every tool the runner can execute. Optionally filter by family " +
        "(csv, json, pdf, image, audio, video, connector, etc.) or substring " +
        "search across slug + description. Returns slug, family, runtime, " +
        "tier required, and bundle metadata.",
      inputSchema: {
        family: z.string().optional().describe("Filter by family"),
        query: z.string().optional().describe("Substring match on slug"),
      },
    },
    async ({ family, query }) => {
      const list = await deps.catalogue.list();
      let filtered = list;
      if (family) {
        filtered = filtered.filter((t) => t.toolId.startsWith(family) || t.slug.startsWith(family));
      }
      if (query) {
        const q = query.toLowerCase();
        filtered = filtered.filter((t) => t.slug.toLowerCase().includes(q));
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              filtered.map((t) => ({
                slug: t.slug,
                toolId: t.toolId,
                runtime: t.runtime,
                tierRequired: t.tierRequired,
                version: t.version,
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
    "tool_run",
    {
      title: "Run a tool by slug",
      description:
        "Execute a single tool with optional file inputs and config options. " +
        "Files supplied as base64 are materialised into a per-run scratch dir; " +
        "the primary output (if small enough) is returned inline as base64.",
      inputSchema: {
        slug: z.string().describe("Tool slug from tool_list"),
        files: z
          .array(
            z.object({
              filename: z.string(),
              mimeType: z.string().default("application/octet-stream"),
              base64: z.string().describe("Base64-encoded file contents"),
            }),
          )
          .optional()
          .default([])
          .describe("File inputs"),
        options: z.record(z.unknown()).optional().default({}).describe("Tool config object"),
        text: z.string().optional().describe("Plain text input (alternative to files for text-based tools)"),
      },
    },
    async ({ slug, files, options, text }) => {
      const entry = await deps.catalogue.lookup(slug);
      if (!entry) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Tool not found in catalogue: ${slug}` }],
        };
      }

      let access;
      try {
        access = await deps.tokens.getAccessToken();
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Runner unpaired: ${(err as Error).message}` }],
        };
      }

      const runId = randomUUID();
      const scratchDir = deps.scratch.acquire(runId);
      const fileRefs: FileRef[] = [];
      let concurrencyAcquired = false;

      try {
        for (const file of files ?? []) {
          const buf = Buffer.from(file.base64, "base64");
          const safeName = file.filename.replace(/[^a-zA-Z0-9_.-]/g, "_");
          const sha = await sha256Hex(buf);
          const ref = `${sha.slice(0, 16)}-${safeName}`;
          await writeFile(join(scratchDir, ref), buf);
          fileRefs.push({
            ref,
            bytes: buf.length,
            sha256: sha,
            mime: file.mimeType,
            filename: file.filename,
          });
        }

        // Phase 9 pre-flight — same checks the HTTP slug-dispatch route does,
        // so MCP clients can't bypass tier-limit enforcement.
        const violation = checkFamilyLimits(access, entry, fileRefs);
        if (violation) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(violationToHttpBody(violation), null, 2),
              },
            ],
          };
        }

        const permits = access.streaming?.batchMaxParallel ?? 0;
        if (!deps.concurrency.tryAcquire(access.sub, permits)) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    error: "tier_limit_exceeded",
                    limit: { type: "concurrency", value: permits },
                    upgrade_url: "https://jadapps.app/pricing",
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        concurrencyAcquired = true;

        const inputs = { ...(options ?? {}) };
        if (text != null) inputs.text = inputs.text ?? text;

        const runToken: RunToken = {
          runId,
          jwt: access.jwt,
          byteBudget: access.limits.maxBytesPerRun,
          expiresAt: access.expiresAt,
          allowedRuntimes: [
            "runner-local",
            "runner-native",
            "runner-builtin",
            "browser-native",
            "runner-via-server",
          ],
          tools: [
            {
              stepIndex: 0,
              toolId: entry.toolId,
              bundleUrl: entry.bundleUrl,
              bundleSha256: entry.bundleSha256,
              decryptionKey: entry.decryptionKey ?? null,
              runtime: entry.runtime,
              ttlSec: 600,
            },
          ],
        };

        const step: StepDescriptor = {
          runId,
          stepIndex: 0,
          toolId: entry.toolId,
          inputs,
          fileRefs,
          credentialRefs: extractCredentialRefs(inputs),
        };

        const result = await deps.executor.execute({ runToken, step });

        if (!result.ok) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    error: result.error?.code ?? "tool_failed",
                    message: result.error?.message,
                    outputs: result.outputs,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        const content: Array<
          | { type: "text"; text: string }
          | { type: "resource"; resource: { uri: string; mimeType: string; blob: string } }
        > = [];
        content.push({
          type: "text",
          text: JSON.stringify(
            { ok: true, durationMs: result.durationMs, outputs: result.outputs },
            null,
            2,
          ),
        });

        // Inline the primary output file as base64 if small enough; otherwise
        // surface a runner:// URI the client can fetch.
        const primary = result.fileRefs[0];
        if (primary) {
          const path = deps.scratch.resolve(runId, primary.ref);
          const buf = await readFile(path).catch(() => null);
          if (buf && buf.length <= INLINE_OUTPUT_CAP) {
            content.push({
              type: "resource",
              resource: {
                uri: `runner://runs/${runId}/files/${primary.ref}`,
                mimeType: primary.mime,
                blob: buf.toString("base64"),
              },
            });
          } else {
            content.push({
              type: "text",
              text: `Output file too large for inline transfer (${primary.bytes} bytes). Fetch via runner://runs/${runId}/files/${primary.ref}`,
            });
          }
        }

        return { content };
      } finally {
        deps.scratch.release(runId);
        if (concurrencyAcquired) deps.concurrency.release(access.sub);
      }
    },
  );
}

async function sha256Hex(buf: Buffer): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(buf).digest("hex");
}

function extractCredentialRefs(inputs: Record<string, unknown>): string[] {
  const refs = new Set<string>();
  if (typeof inputs.credentialRef === "string" && inputs.credentialRef.trim()) {
    refs.add(inputs.credentialRef.trim());
  }
  if (Array.isArray(inputs.credentialRefs)) {
    for (const r of inputs.credentialRefs) {
      if (typeof r === "string" && r.trim()) refs.add(r.trim());
    }
  }
  return [...refs];
}
