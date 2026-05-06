import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createHash } from "node:crypto";
import { writeFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import type { Executor } from "../runtime/executor.js";
import type { CredentialStore } from "../credentials/store.js";
import type { TokenManager } from "../auth/tokens.js";
import type { TelemetryClient } from "../telemetry/client.js";
import type { ScratchManager } from "../runtime/scratch.js";
import type { Logger } from "../log.js";
import type { RunToken, StepDescriptor } from "../types.js";

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

const ExecuteBody = z.object({
  runToken: z.object({
    runId: z.string(),
    jwt: z.string(),
    byteBudget: z.number(),
    expiresAt: z.number(),
    allowedRuntimes: z.array(
      z.enum(["browser", "runner-local", "runner-native", "runner-via-server"]),
    ),
    tools: z.array(
      z.object({
        stepIndex: z.number(),
        toolId: z.string(),
        bundleUrl: z.string(),
        bundleSha256: z.string(),
        decryptionKey: z.string().nullable(),
        runtime: z.enum(["browser", "runner-local", "runner-native", "runner-via-server"]),
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
  log: Logger;
  pairingToken: string;
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
