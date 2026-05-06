import Fastify from "fastify";
import cors from "@fastify/cors";
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
    log: opts.log,
    pairingToken,
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
