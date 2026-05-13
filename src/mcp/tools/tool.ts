import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import { writeFile, readFile, stat, link, copyFile, mkdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
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
      title: "Run a JAD tool against file input(s) on this machine",
      description:
        "Run a JAD tool on a local file. Pick the input mode by what you actually " +
        "have in hand — they're listed in order of preference:\n\n" +
        "  1. inputContent — raw text content as a string. **USE THIS when the user " +
        "pasted text into chat or the file body is already in your context.** The " +
        "runner writes it to a file on disk for you. You never have to base64-encode " +
        "anything; LLM-generated base64 is unreliable and slow.\n\n" +
        "  2. inputPaths — absolute paths (or relative paths combined with `cwd`). " +
        "**USE THIS when the user names a file or you can see one on disk.** " +
        "Hard-linked into the per-run scratch dir; no wire transfer of file " +
        "content. The original file is never modified.\n\n" +
        "  3. files[] — base64 inline. **Last resort.** Works on any MCP client but " +
        "slow over JSON-RPC and error-prone for LLMs to produce.\n\n" +
        "Mix freely; all three resolve to the same FileRef[] the tool sees.\n\n" +
        "Outputs: if you used inputPaths, the cleaned/converted file is written to " +
        "`<dirname(inputPaths[0])>/jadapps-out/` by default and the response carries " +
        "outputPaths. Override with an explicit `outputDir` (absolute). If you only " +
        "used inputContent or files[], the response inlines the primary output " +
        "as a small base64 resource (≤4 MB) unless you set outputDir explicitly.",
      inputSchema: {
        slug: z.string().describe("Tool slug from tool_list (e.g. 'csv-cleaner', 'pdf-merge', 'image-resizer')"),
        inputContent: z
          .union([
            z
              .string()
              .describe("Raw text content. Filename is inferred from slug + mimeType."),
            z.array(
              z.object({
                filename: z.string(),
                content: z.string().describe("Raw text content (not base64)"),
                mimeType: z.string().optional(),
              }),
            ),
          ])
          .optional()
          .describe(
            "Inline text-content file inputs. Bypasses base64 entirely — preferred " +
              "whenever the file body is already a string in your context.",
          ),
        inputPaths: z
          .array(
            z.union([
              z
                .string()
                .describe("Path to a local file (absolute, or relative when `cwd` is set)"),
              z.object({
                path: z.string(),
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
              "copied cross-volume. Avoids the base64 round-trip.",
          ),
        cwd: z
          .string()
          .optional()
          .describe(
            "Absolute working directory used to resolve any relative entries in " +
              "inputPaths. Required if any inputPaths entry isn't already absolute.",
          ),
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
          .describe(
            "Inline base64 file inputs. Last-resort mode — prefer inputContent " +
              "for text or inputPaths for paths.",
          ),
        outputDir: z
          .string()
          .optional()
          .describe(
            "Absolute directory to write outputs to. Defaults to " +
              "`<dirname(inputPaths[0])>/jadapps-out/` when inputPaths is set. " +
              "Created if it doesn't exist. When set, the response returns " +
              "outputPaths instead of inline base64.",
          ),
        overwrite: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Allow clobbering an existing file with the same name in outputDir. " +
              "Off by default; the call errors out if a target already exists.",
          ),
        options: z.record(z.unknown()).optional().default({}).describe("Tool config object"),
        text: z
          .string()
          .optional()
          .describe(
            "Plain text fed straight into the tool's options.text — for tools " +
              "that natively consume strings rather than files (e.g. md-from-text).",
          ),
      },
    },
    async ({
      slug,
      files,
      inputContent,
      inputPaths,
      cwd,
      outputDir,
      overwrite,
      options,
      text,
    }) => {
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
      if (cwd !== undefined && !isAbsolute(cwd)) {
        return {
          isError: true,
          content: [
            { type: "text" as const, text: `cwd must be an absolute path; got ${cwd}` },
          ],
        };
      }

      const runId = randomUUID();
      const scratchDir = deps.scratch.acquire(runId);
      const fileRefs: FileRef[] = [];
      let firstResolvedInputPath: string | null = null;
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

        // inputContent: write raw strings to scratch as files. Filename is
        // either supplied explicitly or inferred from slug + mimeType.
        const contentEntries = normaliseInputContent(inputContent, slug);
        for (const entry of contentEntries) {
          const materialized = await materializeContentInput(entry, scratchDir);
          fileRefs.push(materialized);
        }

        for (const entry of inputPaths ?? []) {
          const spec =
            typeof entry === "string"
              ? { path: entry, mimeType: undefined, filename: undefined }
              : entry;
          const resolved = resolveInputPath(spec.path, cwd);
          if ("error" in resolved) {
            return {
              isError: true,
              content: [{ type: "text" as const, text: resolved.error }],
            };
          }
          const materialized = await materializePathInput(
            { ...spec, path: resolved.path },
            scratchDir,
          );
          if ("error" in materialized) {
            return {
              isError: true,
              content: [{ type: "text" as const, text: materialized.error }],
            };
          }
          fileRefs.push(materialized.ref);
          if (firstResolvedInputPath === null) firstResolvedInputPath = resolved.path;
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

        // Default outputDir when the caller used inputPaths: write alongside
        // the input under `./jadapps-out/`. This makes the natural request
        // "clean this file" land the cleaned version next to the original
        // without the caller having to spell out a target. Skipped when only
        // inputContent or files[] was used — no anchor, so fall through to
        // the inline base64 response.
        const effectiveOutputDir =
          outputDir ??
          (firstResolvedInputPath
            ? join(dirname(firstResolvedInputPath), "jadapps-out")
            : undefined);

        // outputDir mode: write every output file to the caller's directory
        // and return paths. No base64 in the response, no 4 MB inline cap.
        if (effectiveOutputDir !== undefined) {
          const written = await writeOutputsToDir({
            outputDir: effectiveOutputDir,
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

interface NormalisedContentEntry {
  filename: string;
  content: string;
  mimeType: string | undefined;
}

/**
 * Reshape the `inputContent` argument (string or array) into the array form
 * the materializer wants, picking sensible filenames when the caller didn't
 * supply one. Returns [] when the argument isn't set.
 */
function normaliseInputContent(
  raw: unknown,
  slug: string,
): NormalisedContentEntry[] {
  if (raw == null) return [];
  if (typeof raw === "string") {
    return [
      {
        filename: inferContentFilename(slug, undefined),
        content: raw,
        mimeType: undefined,
      },
    ];
  }
  if (Array.isArray(raw)) {
    return raw.map((entry) => {
      if (
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { filename?: unknown }).filename === "string" &&
        typeof (entry as { content?: unknown }).content === "string"
      ) {
        const e = entry as { filename: string; content: string; mimeType?: string };
        return { filename: e.filename, content: e.content, mimeType: e.mimeType };
      }
      throw new Error(
        "inputContent array entries must be { filename, content, mimeType? } objects",
      );
    });
  }
  return [];
}

/**
 * Infer a sensible filename for an inline-text input. Goes by an explicit
 * mimeType first; falls back to the slug's family prefix.
 *
 * Conservative on purpose — when the model passes inputContent for an
 * obviously-binary family (image/audio/video) we still let it through but
 * label the file as `.bin` so anything downstream that branches on extension
 * can fail loudly rather than silently mis-treating the bytes.
 */
function inferContentFilename(slug: string, mimeType: string | undefined): string {
  if (mimeType) {
    const byMime: Record<string, string> = {
      "text/csv": "input.csv",
      "text/tab-separated-values": "input.tsv",
      "application/json": "input.json",
      "application/x-ndjson": "input.ndjson",
      "text/markdown": "input.md",
      "text/html": "input.html",
      "application/xml": "input.xml",
      "text/xml": "input.xml",
      "text/yaml": "input.yaml",
      "application/yaml": "input.yaml",
      "image/svg+xml": "input.svg",
      "text/plain": "input.txt",
    };
    if (mimeType in byMime) return byMime[mimeType]!;
  }
  const family = (slug.split("-")[0] ?? "").toLowerCase();
  const byFamily: Record<string, string> = {
    csv: "input.csv",
    json: "input.json",
    md: "input.md",
    markdown: "input.md",
    html: "input.html",
    pdf: "input.pdf",
    xml: "input.xml",
    yaml: "input.yaml",
    svg: "input.svg",
    excel: "input.xlsx",
    image: "input.bin",
    audio: "input.bin",
    video: "input.bin",
    archive: "input.bin",
    font: "input.bin",
  };
  return byFamily[family] ?? "input.txt";
}

async function materializeContentInput(
  entry: NormalisedContentEntry,
  scratchDir: string,
): Promise<FileRef> {
  const buf = Buffer.from(entry.content, "utf8");
  const safeName = entry.filename.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const sha = await sha256Hex(buf);
  const ref = `${sha.slice(0, 16)}-${safeName}`;
  await writeFile(join(scratchDir, ref), buf);
  return {
    ref,
    bytes: buf.length,
    sha256: sha,
    mime: entry.mimeType ?? guessMimeFromName(entry.filename),
    filename: entry.filename,
  };
}

function guessMimeFromName(name: string): string {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  const map: Record<string, string> = {
    csv: "text/csv",
    tsv: "text/tab-separated-values",
    json: "application/json",
    ndjson: "application/x-ndjson",
    md: "text/markdown",
    html: "text/html",
    xml: "application/xml",
    yaml: "application/yaml",
    yml: "application/yaml",
    svg: "image/svg+xml",
    txt: "text/plain",
  };
  return map[ext] ?? "application/octet-stream";
}

/**
 * Resolve an inputPaths entry against the caller's `cwd`. Returns the
 * absolute path or an explanation if relative and no cwd was supplied.
 */
function resolveInputPath(
  path: string,
  cwd: string | undefined,
): { path: string } | { error: string } {
  if (!path || typeof path !== "string") {
    return { error: `inputPaths entry missing 'path'` };
  }
  if (isAbsolute(path)) return { path: resolve(path) };
  if (!cwd) {
    return {
      error:
        `inputPath '${path}' is relative; supply an absolute path or set 'cwd' ` +
        `to an absolute working directory so the runner knows how to resolve it.`,
    };
  }
  return { path: resolve(cwd, path) };
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
  const usedThisRun = new Set<string>();
  for (const ref of args.outputRefs) {
    const initialDst = join(target, ref.filename);
    let dst = initialDst;

    // When the would-be destination collides — either with a file already on
    // disk OR with another output we just wrote in this same run — append
    // `.out` before the extension and try again. Repeat (`foo.out.out.csv`,
    // …) until a free name is found. Keeps the runner from silently
    // overwriting an input file when the caller picks `outputDir == dir(input)`.
    // `overwrite: true` opts out and clobbers the original target, matching
    // the previous behaviour for callers who really mean it.
    if (!args.overwrite) {
      while (
        usedThisRun.has(dst) ||
        (await stat(dst).then(
          () => true,
          () => false,
        ))
      ) {
        dst = appendOutSuffix(dst);
      }
    }
    usedThisRun.add(dst);

    const src = args.scratch.resolve(args.runId, ref.ref);
    try {
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

/**
 * Insert `.out` before the file extension so a copy doesn't clobber the
 * original. `foo.csv` → `foo.out.csv`; `foo` (no ext) → `foo.out`; existing
 * `foo.out.csv` → `foo.out.out.csv` (the helper keeps stacking on retries).
 *
 * Multi-part extensions like `.tar.gz` get a single suffix at the rightmost
 * dot (`archive.tar.out.gz`) — good enough for the runner's outputs, none
 * of which currently emit doubled extensions.
 */
function appendOutSuffix(path: string): string {
  const lastSep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const dir = lastSep >= 0 ? path.slice(0, lastSep + 1) : "";
  const base = lastSep >= 0 ? path.slice(lastSep + 1) : path;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return `${dir}${base}.out`;
  return `${dir}${base.slice(0, dot)}.out${base.slice(dot)}`;
}

// Test-only re-exports. The helpers above are deliberately private — the
// tool_run handler is the only intended caller. Tests reach in via these
// underscore-prefixed names so renames break compilation rather than silently
// drifting from the production code path.
export const __test_materializePathInput = materializePathInput;
export const __test_writeOutputsToDir = writeOutputsToDir;
export const __test_normaliseInputContent = normaliseInputContent;
export const __test_materializeContentInput = materializeContentInput;
export const __test_inferContentFilename = inferContentFilename;
export const __test_resolveInputPath = resolveInputPath;
export const __test_appendOutSuffix = appendOutSuffix;

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
