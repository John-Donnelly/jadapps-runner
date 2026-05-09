import { loadConfig, paths } from "./config.js";
import { createLogger } from "./log.js";
import { SecretStore } from "./auth/keychain.js";
import { ApiClient } from "./api/client.js";
import { PairingService } from "./auth/pairing.js";
import { TokenManager } from "./auth/tokens.js";
import { CredentialStore } from "./credentials/store.js";
import { WorkflowStore } from "./workflows/store.js";
import { WorkflowSync } from "./workflows/sync.js";
import { LocalWorkflowRunner } from "./workflows/runner.js";
import { EventQueue } from "./telemetry/queue.js";
import { TelemetryClient } from "./telemetry/client.js";
import { ScratchManager } from "./runtime/scratch.js";
import { BundleLoader } from "./runtime/bundle-loader.js";
import { WorkerPool } from "./runtime/worker-pool.js";
import { Executor } from "./runtime/executor.js";
import { ToolCatalogue } from "./runtime/tool-catalogue.js";
import { BrowserWorker } from "./runtime/browser-worker.js";
import { ConcurrencyLimiter } from "./runtime/concurrency.js";
import { bootHttpServer, type ServerHandle } from "./server/http.js";
import { DispatchPoller } from "./dispatch/poller.js";
import { WakeSocket } from "./dispatch/wake-socket.js";

const STALE_SCRATCH_AGE_MS = 24 * 60 * 60 * 1000;

export interface Runner {
  shutdown(): Promise<void>;
  pairing: PairingService;
  tokens: TokenManager;
  pairingToken: string;
  port: number;
  apiBase: string;
  // Exposed for the `mcp` CLI subcommand — bypasses the HTTP layer and
  // hands these straight to McpServer over stdio. Keep the surface narrow.
  log: import("./log.js").Logger;
  executor: Executor;
  catalogue: ToolCatalogue;
  credentials: CredentialStore;
  scratch: ScratchManager;
  workflowStore: WorkflowStore;
  workflowSync: WorkflowSync;
  localWorkflowRunner: LocalWorkflowRunner;
  api: ApiClient;
  eventQueue: EventQueue;
  concurrency: ConcurrencyLimiter;
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

  const workflowStore = new WorkflowStore(credentials.rawDb());
  workflowStore.init();
  const workflowSync = new WorkflowSync(api, tokens, workflowStore, log);

  const queue = new EventQueue(credentials.rawDb());
  const telemetry = new TelemetryClient(queue, api, log);

  const scratch = new ScratchManager(paths(cfg).scratch);
  const removed = scratch.sweepStale(STALE_SCRATCH_AGE_MS);
  if (removed > 0) log.info({ removed }, "swept stale scratch dirs");

  const bundles = new BundleLoader(api, log);
  const workers = new WorkerPool(log);
  const browserWorker = new BrowserWorker(log, scratch);
  const executor = new Executor(
    log,
    api,
    tokens,
    credentials,
    telemetry,
    bundles,
    workers,
    scratch,
    browserWorker,
  );
  const catalogue = new ToolCatalogue(api, tokens, log);
  const concurrency = new ConcurrencyLimiter();
  const localWorkflowRunner = new LocalWorkflowRunner(executor, catalogue, tokens, scratch, log);

  telemetry.start();

  const server = await bootHttpServer({
    cfg,
    log,
    executor,
    credentials,
    tokens,
    telemetry,
    scratch,
    catalogue,
    api,
    workflowStore,
    workflowSync,
    localWorkflowRunner,
    eventQueue: queue,
    concurrency,
  });

  // Best-effort sync on startup. Failures are logged inside WorkflowSync —
  // the runner stays usable even if the website is unreachable.
  void workflowSync
    .sync()
    .then((result) => {
      if (result.pulled > 0 || result.pushed > 0) {
        log.info(result, "initial workflow sync complete");
      }
    })
    .catch((err) => log.warn({ err }, "initial workflow sync threw"));

  let poller: DispatchPoller | null = null;
  let wakeSocket: WakeSocket | null = null;
  if (cfg.autoDispatch) {
    poller = new DispatchPoller(cfg.apiBase, tokens, executor, scratch, api, log);
    poller.start();
    log.info({ apiBase: cfg.apiBase }, "auto-dispatch poller running");

    const wakeBase = process.env.JADAPPS_RUNNER_WSS_URL;
    if (wakeBase) {
      wakeSocket = new WakeSocket(wakeBase, tokens, () => poller!.kick(), log);
      wakeSocket.start();
      log.info({ wssUrl: wakeBase }, "wake socket enabled");
    }
  }

  const shutdown = makeShutdown(log, server, telemetry, workers, bundles, browserWorker, poller, wakeSocket);
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
    log,
    executor,
    catalogue,
    credentials,
    scratch,
    workflowStore,
    workflowSync,
    localWorkflowRunner,
    api,
    eventQueue: queue,
    concurrency,
  };
}

function makeShutdown(
  log: ReturnType<typeof createLogger>,
  server: ServerHandle,
  telemetry: TelemetryClient,
  workers: WorkerPool,
  bundles: BundleLoader,
  browserWorker: BrowserWorker,
  poller: DispatchPoller | null,
  wakeSocket: WakeSocket | null,
): () => Promise<void> {
  let shutting = false;
  return async () => {
    if (shutting) return;
    shutting = true;
    log.info("shutting down runner");
    try {
      if (wakeSocket) await wakeSocket.stop();
      if (poller) await poller.stop();
      telemetry.stop();
      await telemetry.flush().catch(() => undefined);
      await server.shutdown();
      await workers.shutdown();
      bundles.shutdown();
      await browserWorker.shutdown();
    } catch (err) {
      log.error({ err }, "error during shutdown");
    }
  };
}
