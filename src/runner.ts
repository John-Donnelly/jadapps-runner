import { loadConfig, paths } from "./config.js";
import { createLogger } from "./log.js";
import { SecretStore } from "./auth/keychain.js";
import { ApiClient } from "./api/client.js";
import { PairingService } from "./auth/pairing.js";
import { TokenManager } from "./auth/tokens.js";
import { CredentialStore } from "./credentials/store.js";
import { EventQueue } from "./telemetry/queue.js";
import { TelemetryClient } from "./telemetry/client.js";
import { ScratchManager } from "./runtime/scratch.js";
import { BundleLoader } from "./runtime/bundle-loader.js";
import { WorkerPool } from "./runtime/worker-pool.js";
import { Executor } from "./runtime/executor.js";
import { bootHttpServer, type ServerHandle } from "./server/http.js";

const STALE_SCRATCH_AGE_MS = 24 * 60 * 60 * 1000;

export interface Runner {
  shutdown(): Promise<void>;
  pairing: PairingService;
  tokens: TokenManager;
  pairingToken: string;
  port: number;
  apiBase: string;
}

/** Wire the dependency graph and start the local HTTP server. */
export async function startRunner(): Promise<Runner> {
  const cfg = loadConfig();
  const log = createLogger(cfg.logLevel);
  log.info({ cfg }, "starting runner");

  const secrets = new SecretStore(cfg.dataDir);
  const api = new ApiClient(cfg.apiBase, log);
  const pairing = new PairingService(cfg, secrets, api);
  const tokens = new TokenManager(api, pairing);

  const credentials = new CredentialStore(paths(cfg).sqlite, secrets);
  await credentials.init();

  const queue = new EventQueue(credentials.rawDb());
  const telemetry = new TelemetryClient(queue, api, log);

  const scratch = new ScratchManager(paths(cfg).scratch);
  const removed = scratch.sweepStale(STALE_SCRATCH_AGE_MS);
  if (removed > 0) log.info({ removed }, "swept stale scratch dirs");

  const bundles = new BundleLoader(api, log);
  const workers = new WorkerPool(log);
  const executor = new Executor(log, api, tokens, credentials, telemetry, bundles, workers, scratch);

  telemetry.start();

  const server = await bootHttpServer({ cfg, log, executor, credentials, tokens, telemetry, scratch });

  const shutdown = makeShutdown(log, server, telemetry, workers, bundles);
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  if (secrets.isUsingFallback()) {
    log.warn(
      "OS keychain unavailable; secrets are stored in user data dir with file permissions only. " +
        "Install platform keychain support for stronger protection.",
    );
  }

  return {
    shutdown,
    pairing,
    tokens,
    pairingToken: server.pairingToken,
    port: server.port,
    apiBase: cfg.apiBase,
  };
}

function makeShutdown(
  log: ReturnType<typeof createLogger>,
  server: ServerHandle,
  telemetry: TelemetryClient,
  workers: WorkerPool,
  bundles: BundleLoader,
): () => Promise<void> {
  let shutting = false;
  return async () => {
    if (shutting) return;
    shutting = true;
    log.info("shutting down runner");
    try {
      telemetry.stop();
      await telemetry.flush().catch(() => undefined);
      await server.shutdown();
      await workers.shutdown();
      bundles.shutdown();
    } catch (err) {
      log.error({ err }, "error during shutdown");
    }
  };
}
