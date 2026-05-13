import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import { writeFile, readFile, stat, link, copyFile, mkdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
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
        "Execute a single tool with optional file inputs and config options.\n\n" +
        "Three input modes, mix freely:\n" +
        "  • files[]      — base64 inline; works for any MCP client but slow over " +
        "JSON-RPC. Best for small files or non-loopback clients.\n" +
        "  • inputPaths[] — absolute paths on the local filesystem. The runner " +
        "hard-links (or copies cross-volume) each file into the per-run scratch " +
        "dir. Zero network/protocol overhead — use this for anything over a few " +
        "MB on a loopback MCP client.\n" +
        "  • text         — plain-text alternative for text-based tools.\n\n" +
        "Output: by default the primary output file is returned inline as a " +
        "base64 resource (capped at 4 MB) and any extras are surfaced as " +
        "runner:// URIs. Pass `outputDir` to instead write every output file to " +
        "that directory and return the resulting paths — no base64 in the " +
        "response, no inline size ceiling.",
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
          .describe("Inline (base64) file inputs"),
        inputPaths: z
          .array(
            z.union([
              z.string().describe("Absolute path to a local file"),
              z.object({
                path: z.string().describe("Absolute path to a local file"),
                mimeType: z.string().optional(),
                filename: z
                  .string()
                  .optional()
                  .describe("Name the tool should see (defaults to basename(path))"),
              }),
            ]),
          )
          .optional()
          .default([])
          .describe(
            "Local-path file inputs. Hard-linked into scratch when possible; " +
              "copied as a fallback for cross-volume paths. Avoids the base64 round-trip.",
          ),
        outputDir: z
          .string()
          .optional()
          .describe(
            "If set, write output files here and return paths instead of inline " +
              "base64. Created if it doesn't exist. Must be an absolute path.",
          ),
        overwrite: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "When outputDir is set, allow clobbering an existing file with the " +
              "same name. Off by default; the call errors out if a target exists.",
          ),
        options: z.record(z.unknown()).optional().default({}).describe("Tool config object"),
        text: z.string().optional().describe("Plain text input (alternative to files for text-based tools)"),
      },
    },
    async ({ slug, files, inputPaths, outputDir, overwrite, options, text }) => {
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

      // outputDir, if provided, must be absolute — relative resolution against
      // the runner's CWD is a footgun (CWD changes across the Tauri shell vs
      // npm-global vs `node cli.js start` launch paths).
      if (outputDir !== undefined && !isAbsolute(outputDir)) {
        return {
          isError: true,
          content: [
            { type: "text" as const, text: `outputDir must be an absolute path; got ${outputDir}` },
          ],
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

        for (const entry of inputPaths ?? []) {
          const spec =
            typeof entry === "string"
              ? { path: entry, mimeType: undefined, filename: undefined }
              : entry;
          const materialized = await materializePathInput(spec, scratchDir);
          if ("error" in materialized) {
            return {
              isError: true,
              content: [{ type: "text" as const, text: materialized.error }],
            };
          }
          fileRefs.push(materialized.ref);
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

        // outputDir mode: write every output file to the caller's directory
        // and return paths. No base64 in the response, no 4 MB inline cap.
        if (outputDir !== undefined) {
          const written = await writeOutputsToDir({
            outputDir,
            overwrite: !!overwrite,
            runId,
            outputRefs: result.fileRefs,
            scratch: deps.scratch,
          });
          if ("error" in written) {
            return {
              isError: true,
              content: [{ type: "text" as const, text: written.error }],
            };
          }
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    ok: true,
                    durationMs: result.durationMs,
                    outputs: result.outputs,
                    outputPaths: written.paths,
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
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Stream-hash a local file. Used by the path-mode input materializer so we
 * never load the whole file into memory just to compute a content hash.
 */
async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolveStream, rejectStream) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveStream());
    stream.on("error", rejectStream);
  });
  return hash.digest("hex");
}

interface PathInputSpec {
  path: string;
  mimeType?: string | undefined;
  filename?: string | undefined;
}

/**
 * Hard-link (or copy, cross-volume) a local file into the per-run scratch
 * dir and return a FileRef the executor + bundles can consume. The original
 * file is untouched; cleanup of the scratch dir doesn't delete it.
 */
async function materializePathInput(
  spec: PathInputSpec,
  scratchDir: string,
): Promise<{ ref: FileRef } | { error: string }> {
  if (!spec.path || typeof spec.path !== "string") {
    return { error: `inputPaths entry missing 'path'` };
  }
  if (!isAbsolute(spec.path)) {
    return { error: `inputPaths must be absolute; got ${spec.path}` };
  }
  const abs = resolve(spec.path);
  let st;
  try {
    st = await stat(abs);
  } catch (err) {
    return { error: `inputPath unreadable: ${abs} (${(err as Error).message})` };
  }
  if (!st.isFile()) {
    return { error: `inputPath is not a regular file: ${abs}` };
  }

  const filename = spec.filename ?? basename(abs);
  const safeName = filename.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const sha = await sha256OfFile(abs);
  const ref = `${sha.slice(0, 16)}-${safeName}`;
  const target = join(scratchDir, ref);

  // Hard link first — instant on the same volume, no extra disk. Falls back
  // to copy on EXDEV (cross-volume) or EPERM (some filesystems refuse links).
  try {
    await link(abs, target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EXDEV" || code === "EPERM" || code === "EACCES") {
      await copyFile(abs, target);
    } else {
      throw err;
    }
  }

  return {
    ref: {
      ref,
      bytes: st.size,
      sha256: sha,
      mime: spec.mimeType ?? "application/octet-stream",
      filename,
    },
  };
}

interface WriteOutputsArgs {
  outputDir: string;
  overwrite: boolean;
  runId: string;
  outputRefs: FileRef[];
  scratch: McpDeps["scratch"];
}

async function writeOutputsToDir(
  args: WriteOutputsArgs,
): Promise<{ paths: string[] } | { error: string }> {
  const target = resolve(args.outputDir);
  await mkdir(target, { recursive: true });

  const paths: string[] = [];
  for (const ref of args.outputRefs) {
    const dst = join(target, ref.filename);
    if (!args.overwrite) {
      // stat returning success means the file is already there; the call
      // bails out instead of clobbering. Callers can pass overwrite: true.
      const exists = await stat(dst).then(
        () => true,
        () => false,
      );
      if (exists) {
        return {
          error: `${dst} already exists. Pass overwrite: true to replace, or pick a different filename.`,
        };
      }
    }
    const src = args.scratch.resolve(args.runId, ref.ref);
    try {
      // Hard link is instantaneous on the same volume and leaves both paths
      // pointing at the same content. Cross-volume / Windows-quirk fallbacks
      // mirror the input-materializer above.
      try {
        if (args.overwrite) {
          // link() fails if target exists; remove first when overwriting.
          await stat(dst).then(
            async () => {
              const { unlink } = await import("node:fs/promises");
              await unlink(dst);
            },
            () => undefined,
          );
        }
        await link(src, dst);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EXDEV" || code === "EPERM" || code === "EACCES") {
          await copyFile(src, dst);
        } else {
          throw err;
        }
      }
      paths.push(dst);
    } catch (err) {
      return { error: `failed to write ${dst}: ${(err as Error).message}` };
    }
  }
  return { paths };
}

// Test-only re-exports. The helpers above are deliberately private — the
// tool_run handler is the only intended caller. Tests reach in via these
// underscore-prefixed names so renames break compilation rather than silently
// drifting from the production code path.
export const __test_materializePathInput = materializePathInput;
export const __test_writeOutputsToDir = writeOutputsToDir;

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
