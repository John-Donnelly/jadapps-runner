import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { randomBytes } from "node:crypto";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { RunnerConfig } from "../config.js";
import type { Logger } from "../log.js";
import { registerRoutes } from "./routes.js";
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
import type { ConcurrencyLimiter } from "../runtime/concurrency.js";
import { mountMcpHttp } from "../mcp/http-transport.js";

const PAIRING_TOKEN_FILE = "pairing-token";

export interface ServerHandle {
  app: FastifyInstance;
  pairingToken: string;
  port: number;
  shutdown(): Promise<void>;
}

interface BootOptions {
  cfg: RunnerConfig;
  log: Logger;
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
  eventQueue: import("../telemetry/queue.js").EventQueue;
  concurrency: ConcurrencyLimiter;
}

export async function bootHttpServer(opts: BootOptions): Promise<ServerHandle> {
  const tokenPath = join(opts.cfg.dataDir, PAIRING_TOKEN_FILE);
  let pairingToken: string;
  if (existsSync(tokenPath)) {
    pairingToken = readFileSync(tokenPath, "utf8").trim();
  } else {
    pairingToken = randomBytes(24).toString("base64url");
    writeFileSync(tokenPath, pairingToken, "utf8");
  }

  const app = Fastify({
    logger: false,
    bodyLimit: 32 * 1024 * 1024,
  });

  await app.register(multipart, {
    limits: {
      fileSize: 50 * 1024 * 1024 * 1024, // 50GB; runner has access to disk
      files: 16,
    },
  });

  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      // Allow jadapps.app and any localhost origin (dev)
      const allowed =
        /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ||
        /^https:\/\/(.+\.)?jadapps\.app$/.test(origin);
      cb(null, allowed);
    },
    credentials: false,
  });

  await registerRoutes(app, {
    executor: opts.executor,
    credentials: opts.credentials,
    tokens: opts.tokens,
    telemetry: opts.telemetry,
    scratch: opts.scratch,
    catalogue: opts.catalogue,
    api: opts.api,
    workflowStore: opts.workflowStore,
    workflowSync: opts.workflowSync,
    localWorkflowRunner: opts.localWorkflowRunner,
    concurrency: opts.concurrency,
    log: opts.log,
    pairingToken,
  });

  // MCP over HTTP at /mcp — same Bearer-token auth as the rest of the API,
  // bound to 127.0.0.1 only (never internet-reachable).
  await mountMcpHttp(app, {
    log: opts.log,
    executor: opts.executor,
    catalogue: opts.catalogue,
    tokens: opts.tokens,
    credentials: opts.credentials,
    scratch: opts.scratch,
    workflowStore: opts.workflowStore,
    workflowSync: opts.workflowSync,
    localWorkflowRunner: opts.localWorkflowRunner,
    api: opts.api,
    eventQueue: opts.eventQueue,
    concurrency: opts.concurrency,
  });

  await app.listen({ host: opts.cfg.host, port: opts.cfg.port });
  opts.log.info(
    { host: opts.cfg.host, port: opts.cfg.port, pairingToken: `${pairingToken.slice(0, 6)}…` },
    "runner http server up",
  );

  return {
    app,
    pairingToken,
    port: opts.cfg.port,
    shutdown: async () => {
      await app.close();
    },
  };
}
