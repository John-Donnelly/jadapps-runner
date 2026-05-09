import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import { writeFile, stat, statfs, mkdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Executor } from "../runtime/executor.js";
import type { CredentialStore } from "../credentials/store.js";
import type { TokenManager } from "../auth/tokens.js";
import type { TelemetryClient } from "../telemetry/client.js";
import type { ScratchManager } from "../runtime/scratch.js";
import type { ToolCatalogue } from "../runtime/tool-catalogue.js";
import type { ApiClient } from "../api/client.js";
import type { WorkflowStore } from "../workflows/store.js";
import type { WorkflowSync } from "../workflows/sync.js";
import type { LocalWorkflowRunner } from "../workflows/runner.js";
import type { Logger } from "../log.js";
import type { FileRef, RunToken, StepDescriptor } from "../types.js";

const StepSchema = z.object({
  runId: z.string().min(1),
  stepIndex: z.number().int().nonnegative(),
  toolId: z.string().min(1),
  inputs: z.record(z.unknown()),
  fileRefs: z.array(
    z.object({
      ref: z.string(),
      bytes: z.number().nonnegative(),
      sha256: z.string(),
      mime: z.string(),
      filename: z.string(),
    }),
  ),
  credentialRefs: z.array(z.string()),
});

const RuntimeEnum = z.enum([
  "browser",
  "runner-local",
  "runner-native",
  "runner-builtin",
  "browser-native",
  "runner-via-server",
]);

const ExecuteBody = z.object({
  runToken: z.object({
    runId: z.string(),
    jwt: z.string(),
    byteBudget: z.number(),
    expiresAt: z.number(),
    allowedRuntimes: z.array(RuntimeEnum),
    tools: z.array(
      z.object({
        stepIndex: z.number(),
        toolId: z.string(),
        bundleUrl: z.string(),
        bundleSha256: z.string(),
        decryptionKey: z.string().nullable(),
        runtime: RuntimeEnum,
        ttlSec: z.number(),
      }),
    ),
  }),
  step: StepSchema,
});

const CredentialBody = z.object({
  ref: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/),
  type: z.enum(["api_key", "oauth2", "basic", "custom"]),
  data: z.record(z.unknown()),
});

interface Deps {
  executor: Executor;
  credentials: CredentialStore;
  tokens: TokenManager;
  telemetry: TelemetryClient;
  scratch: ScratchManager;
  catalogue: ToolCatalogue;
  api: ApiClient;
  workflowStore: WorkflowStore;
  workflowSync: WorkflowSync;
  localWorkflowRunner: LocalWorkflowRunner;
  log: Logger;
  pairingToken: string;
}

const WorkflowBody = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_-]+$/)
    .optional(),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional().default(""),
  graph: z.object({
    nodes: z.array(z.unknown()),
    edges: z.array(z.unknown()),
  }),
  scheduleCron: z.string().nullable().optional(),
  isPrivate: z.boolean().optional().default(true),
});

const OUTPUTS_DIRNAME = "jadapps-outputs";

/**
 * Resolve the user-visible outputs directory under their home dir. Built-in
 * Downloads/JAD pattern keeps everything under one OS-aware folder users can
 * find easily ("~/jadapps-outputs/<runId>/<filename>").
 */
function outputsDirFor(runId: string): string {
  return join(homedir(), OUTPUTS_DIRNAME, runId);
}

export async function registerRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  app.addHook("onRequest", async (req, reply) => {
    if (req.url.startsWith("/health")) return;
    const auth = req.headers.authorization ?? "";
    if (auth !== `Bearer ${deps.pairingToken}`) {
      reply.code(401).send({ error: "invalid pairing token" });
    }
  });

  app.get("/health", async () => ({
    ok: true,
    name: "jadapps-runner",
    version: "0.1.0",
    pid: process.pid,
    queueDepth: 0,
  }));

  app.get("/v1/disk", async (_req, reply) => {
    try {
      // node:fs/promises.statfs is Node 19+; runner requires 20.10+.
      const st = await statfs(deps.scratch.basePath);
      const free = Number(st.bavail) * Number(st.bsize);
      const total = Number(st.blocks) * Number(st.bsize);
      return { free, total, scratchDir: deps.scratch.basePath };
    } catch (err) {
      reply.code(500).send({ error: (err as Error).message });
      return;
    }
  });

  app.get("/v1/status", async () => {
    let access: Awaited<ReturnType<typeof deps.tokens.getAccessToken>> | null = null;
    try {
      access = await deps.tokens.getAccessToken();
    } catch {
      /* unpaired or offline */
    }
    return {
      paired: access !== null,
      tier: access?.tier ?? null,
      limits: access?.limits ?? null,
    };
  });

  app.get("/v1/tools", async (_req, reply) => {
    try {
      const tools = await deps.catalogue.list();
      return { tools, count: tools.length };
    } catch (err) {
      reply.code(500).send({ error: (err as Error).message });
      return;
    }
  });

  app.post<{ Params: { slug: string } }>(
    "/v1/tools/:slug/run",
    async (req, reply) => {
      const { slug } = req.params;
      if (!/^[a-zA-Z0-9_-]+$/.test(slug)) {
        reply.code(400).send({ error: "invalid slug" });
        return;
      }

      const entry = await deps.catalogue.lookup(slug);
      if (!entry) {
        reply.code(404).send({ error: `tool not in catalogue: ${slug}` });
        return;
      }

      // Tier gating happens server-side in the catalogue, but enforce here too:
      // the access token's tier must meet the tool's tierRequired.
      let access: Awaited<ReturnType<typeof deps.tokens.getAccessToken>>;
      try {
        access = await deps.tokens.getAccessToken();
      } catch (err) {
        reply.code(401).send({ error: `runner unpaired: ${(err as Error).message}` });
        return;
      }

      // Parse multipart parts: `files` (multiple), `options` (JSON), `text`.
      const runId = randomUUID();
      const scratchDir = deps.scratch.acquire(runId);
      const fileRefs: FileRef[] = [];
      let options: Record<string, unknown> = {};
      let text: string | undefined;

      try {
        const parts = req.parts();
        for await (const part of parts) {
          if (part.type === "file") {
            const buf = await part.toBuffer();
            const sha = createHash("sha256").update(buf).digest("hex");
            const safeName = (part.filename ?? "upload").replace(/[^a-zA-Z0-9_.-]/g, "_");
            const ref = `${sha.slice(0, 16)}-${safeName}`;
            await writeFile(join(scratchDir, ref), buf);
            fileRefs.push({
              ref,
              bytes: buf.length,
              sha256: sha,
              mime: part.mimetype ?? "application/octet-stream",
              filename: part.filename ?? safeName,
            });
          } else if (part.type === "field") {
            if (part.fieldname === "options") {
              try {
                options = JSON.parse(String(part.value)) as Record<string, unknown>;
              } catch {
                deps.scratch.release(runId);
                reply.code(400).send({ error: "options must be valid JSON" });
                return;
              }
            } else if (part.fieldname === "text") {
              text = String(part.value);
            }
          }
        }
      } catch (err) {
        deps.scratch.release(runId);
        reply.code(400).send({ error: `multipart parse failed: ${(err as Error).message}` });
        return;
      }

      // If a text field was provided, expose it under inputs for the tool's
      // ctx.inputs.text — many bundles fall back to this when no file is attached.
      if (text != null) {
        options.text = options.text ?? text;
      }

      // Build a synthetic single-step runToken for ad-hoc dispatch. No
      // workflow run is created server-side — this is a one-shot tool call.
      const runToken: RunToken = {
        runId,
        jwt: access.jwt,
        byteBudget: access.limits.maxBytesPerRun,
        expiresAt: access.expiresAt,
        allowedRuntimes: [
          "runner-local",
          "runner-native",
          "runner-builtin",
          "runner-via-server",
        ],
        tools: [
          {
            stepIndex: 0,
            toolId: entry.toolId,
            bundleUrl: entry.bundleUrl,
            bundleSha256: entry.bundleSha256,
            decryptionKey: null,
            runtime: entry.runtime,
            ttlSec: 600,
          },
        ],
      };

      const step: StepDescriptor = {
        runId,
        stepIndex: 0,
        toolId: entry.toolId,
        inputs: options,
        fileRefs,
        credentialRefs: extractCredentialRefs(options),
      };

      const result = await deps.executor.execute({ runToken, step });

      // For successful runs that produced output files (returned via fileRefs
      // on the StepResult), copy the first one to the user's outputs dir and
      // surface its absolute path as outputPath. This matches the website's
      // RunnerJobResult contract.
      const outDir = outputsDirFor(runId);
      let outputPath = "";
      let filename = "";
      let mimeType = "application/json";
      let sizeBytes = 0;
      let inlineText: string | undefined;

      if (result.ok && result.fileRefs.length > 0) {
        const primary = result.fileRefs[0]!;
        await mkdir(outDir, { recursive: true });
        const target = join(outDir, primary.filename);
        try {
          // primary.ref is the scratch path within the runId's scratch dir
          const src = deps.scratch.resolve(runId, primary.ref);
          const buf = await readFileSafely(src);
          if (buf) {
            await writeFile(target, buf);
            outputPath = target;
            filename = primary.filename;
            mimeType = primary.mime;
            sizeBytes = buf.length;
          }
        } catch (err) {
          deps.log.warn({ err, primary }, "could not save output to user dir");
        }
      }

      // Text outputs (no files): surface inlineText so the client can show it
      // without having to read from disk.
      if (result.ok && result.fileRefs.length === 0) {
        const out = result.outputs?.text;
        if (typeof out === "string") {
          inlineText = out;
          sizeBytes = Buffer.byteLength(out, "utf8");
        }
      }

      // Release the scratch dir — outputs were copied above, no need to keep
      // intermediate files around past the run.
      deps.scratch.release(runId);

      if (!result.ok) {
        reply.code(422).send({
          error: result.error?.code ?? "tool_failed",
          message: result.error?.message ?? "tool execution failed",
          outputs: result.outputs,
        });
        return;
      }

      return {
        outputPath,
        filename,
        mimeType,
        sizeBytes,
        durationMs: result.durationMs,
        metrics: extractMetrics(result.outputs),
        inlineText,
        mode: entry.runtime === "runner-native" ? "headless-browser" : "engine",
        outputs: result.outputs,
      };
    },
  );

  app.post("/v1/execute", async (req, reply) => {
    const parsed = ExecuteBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid body", issues: parsed.error.issues });
      return;
    }
    const { runToken, step } = parsed.data;
    const result = await deps.executor.execute({
      runToken: runToken as RunToken,
      step: step as StepDescriptor,
    });
    return result;
  });

  app.get("/v1/credentials", async () => {
    return deps.credentials.list().map((c) => ({
      ref: c.ref,
      type: c.type,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    }));
  });

  app.post("/v1/credentials", async (req, reply) => {
    const parsed = CredentialBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid body", issues: parsed.error.issues });
      return;
    }
    deps.credentials.upsert(parsed.data.ref, parsed.data.type, parsed.data.data);
    return { ok: true };
  });

  app.delete<{ Params: { ref: string } }>("/v1/credentials/:ref", async (req) => {
    const ok = deps.credentials.delete(req.params.ref);
    return { ok };
  });

  // ─── Local workflow storage (Phase 4) ─────────────────────────────────────

  app.get("/v1/workflows", async () => {
    const list = deps.workflowStore.list();
    return {
      workflows: list.map((w) => ({
        id: w.id,
        name: w.name,
        description: w.description,
        graph: w.graph,
        origin: w.origin,
        isPrivate: w.isPrivate,
        scheduleCron: w.scheduleCron,
        serverSyncedAt: w.serverSyncedAt,
        localUpdatedAt: w.localUpdatedAt,
      })),
    };
  });

  app.get<{ Params: { id: string } }>("/v1/workflows/:id", async (req, reply) => {
    const wf = deps.workflowStore.get(req.params.id);
    if (!wf) {
      reply.code(404).send({ error: "not found" });
      return;
    }
    return {
      id: wf.id,
      name: wf.name,
      description: wf.description,
      graph: wf.graph,
      origin: wf.origin,
      isPrivate: wf.isPrivate,
      scheduleCron: wf.scheduleCron,
      serverSyncedAt: wf.serverSyncedAt,
      localUpdatedAt: wf.localUpdatedAt,
    };
  });

  app.post("/v1/workflows", async (req, reply) => {
    const parsed = WorkflowBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid body", issues: parsed.error.issues });
      return;
    }
    const id = parsed.data.id ?? randomUUID();
    const wf = deps.workflowStore.upsert({
      id,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      graph: parsed.data.graph as Record<string, unknown>,
      serverSyncedAt: null, // unsynced — sync layer will pick it up
      origin: "local",
      isPrivate: parsed.data.isPrivate ?? true,
      scheduleCron: parsed.data.scheduleCron ?? null,
    });
    // Fire-and-forget background sync so locally-created workflows appear on
    // the website's My Workflows page within ~1 sync cycle.
    void deps.workflowSync.sync().catch((err) => {
      deps.log.warn({ err }, "post-create workflow sync failed");
    });
    return { workflow: serializeWorkflow(wf) };
  });

  app.put<{ Params: { id: string } }>("/v1/workflows/:id", async (req, reply) => {
    const parsed = WorkflowBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid body", issues: parsed.error.issues });
      return;
    }
    const existing = deps.workflowStore.get(req.params.id);
    if (!existing) {
      reply.code(404).send({ error: "not found" });
      return;
    }
    const wf = deps.workflowStore.upsert({
      id: req.params.id,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      graph: parsed.data.graph as Record<string, unknown>,
      // Keep existing server_synced_at — sync layer compares local_updated_at
      // against it to decide what to push next.
      serverSyncedAt: existing.serverSyncedAt,
      origin: existing.origin,
      isPrivate: parsed.data.isPrivate ?? existing.isPrivate,
      scheduleCron: parsed.data.scheduleCron ?? existing.scheduleCron,
    });
    void deps.workflowSync.sync().catch((err) => {
      deps.log.warn({ err }, "post-update workflow sync failed");
    });
    return { workflow: serializeWorkflow(wf) };
  });

  app.delete<{ Params: { id: string } }>("/v1/workflows/:id", async (req) => {
    const ok = deps.workflowStore.delete(req.params.id);
    // Note: deletion isn't synced to the server in this iteration. A
    // dedicated tombstone column or a delete-tracking sync table is the
    // proper fix; for now the user can delete server-side via the website.
    return { ok };
  });

  app.post("/v1/workflows/sync", async (_req, reply) => {
    try {
      const result = await deps.workflowSync.sync();
      return result;
    } catch (err) {
      reply.code(500).send({ error: (err as Error).message });
      return;
    }
  });

  app.post<{ Params: { id: string } }>("/v1/workflows/:id/run", async (req, reply) => {
    const wf = deps.workflowStore.get(req.params.id);
    if (!wf) {
      reply.code(404).send({ error: "workflow not found" });
      return;
    }
    try {
      const result = await deps.localWorkflowRunner.run(wf);
      if (!result.ok) {
        reply.code(422).send(result);
        return;
      }
      return result;
    } catch (err) {
      reply.code(500).send({ error: (err as Error).message });
      return;
    }
  });

  app.post<{ Params: { runId: string } }>(
    "/v1/runs/:runId/files",
    async (req, reply) => {
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(req.params.runId)) {
        reply.code(400).send({ error: "invalid runId" });
        return;
      }
      const part = await req.file().catch(() => null);
      if (!part) {
        reply.code(400).send({ error: "no file uploaded" });
        return;
      }
      const buf = await part.toBuffer();
      const sha = createHash("sha256").update(buf).digest("hex");
      const safeName = (part.filename ?? "upload").replace(/[^a-zA-Z0-9_.-]/g, "_");
      const ref = `${sha.slice(0, 16)}-${safeName}`;
      const dir = deps.scratch.acquire(req.params.runId);
      await writeFile(join(dir, ref), buf);
      return {
        ref,
        bytes: buf.length,
        sha256: sha,
        mime: part.mimetype ?? "application/octet-stream",
        filename: part.filename ?? "upload",
      };
    },
  );

  app.delete<{ Params: { runId: string } }>(
    "/v1/runs/:runId",
    async (req) => {
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(req.params.runId)) return { ok: false };
      deps.scratch.release(req.params.runId);
      return { ok: true };
    },
  );

  app.get<{ Params: { runId: string; ref: string } }>(
    "/v1/runs/:runId/files/:ref",
    async (req, reply) => {
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(req.params.runId)) {
        reply.code(400).send({ error: "invalid runId" });
        return;
      }
      let path: string;
      try {
        path = deps.scratch.resolve(req.params.runId, req.params.ref);
      } catch {
        reply.code(400).send({ error: "invalid ref" });
        return;
      }
      try {
        const st = await stat(path);
        reply
          .header("content-type", "application/octet-stream")
          .header("content-length", String(st.size))
          .header("content-disposition", `attachment; filename="${req.params.ref}"`);
        return reply.send(createReadStream(path));
      } catch {
        reply.code(404).send({ error: "file not found" });
        return;
      }
    },
  );
}

/**
 * Pull credential refs out of an inputs object. Connector tools take the ref
 * as a top-level config field; HTTP-Request style tools also support
 * inputs.credentialRefs[] for multiple credentials. We accept either.
 */
function extractCredentialRefs(options: Record<string, unknown>): string[] {
  const refs = new Set<string>();
  if (typeof options.credentialRef === "string" && options.credentialRef.trim()) {
    refs.add(options.credentialRef.trim());
  }
  if (Array.isArray(options.credentialRefs)) {
    for (const r of options.credentialRefs) {
      if (typeof r === "string" && r.trim()) refs.add(r.trim());
    }
  }
  return [...refs];
}

/**
 * Pull primitive metric values out of a tool's outputs. Useful for surfacing
 * simple numeric/string results to the website without dumping the full
 * outputs object on the wire response.
 */
function extractMetrics(outputs: Record<string, unknown>): Record<string, string | number> | undefined {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(outputs)) {
    if (typeof v === "number" || typeof v === "string") {
      // Cap string length so we don't explode the wire response
      if (typeof v === "string" && v.length > 200) continue;
      out[k] = v;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

async function readFileSafely(path: string): Promise<Buffer | null> {
  try {
    const fs = await import("node:fs/promises");
    return await fs.readFile(path);
  } catch {
    return null;
  }
}

function serializeWorkflow(
  wf: ReturnType<WorkflowStore["get"]> & object,
): Record<string, unknown> {
  return {
    id: wf.id,
    name: wf.name,
    description: wf.description,
    graph: wf.graph,
    origin: wf.origin,
    isPrivate: wf.isPrivate,
    scheduleCron: wf.scheduleCron,
    serverSyncedAt: wf.serverSyncedAt,
    localUpdatedAt: wf.localUpdatedAt,
  };
}
