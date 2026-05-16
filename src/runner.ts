import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, paths } from "./config.js";
import { createLogger } from "./log.js";
import { SecretStore } from "./auth/keychain.js";
import { ApiClient } from "./api/client.js";
import { PairingService } from "./auth/pairing.js";
import { PreauthRedeemer } from "./auth/preauth.js";
import { TokenManager } from "./auth/tokens.js";
import { LicenseManager } from "./auth/license.js";
import { CredentialStore } from "./credentials/store.js";
import { WorkflowStore } from "./workflows/store.js";
import { WorkflowSync } from "./workflows/sync.js";
import { LocalWorkflowRunner } from "./workflows/runner.js";
import { WebhookStore } from "./webhooks/store.js";
import { WebhookDispatcher } from "./webhooks/dispatcher.js";
import { EventQueue } from "./telemetry/queue.js";
import { TelemetryClient } from "./telemetry/client.js";
import { ScratchManager } from "./runtime/scratch.js";
import { BundleLoader } from "./runtime/bundle-loader.js";
import { WorkerPool } from "./runtime/worker-pool.js";
import { Executor } from "./runtime/executor.js";
import { ToolCatalogue } from "./runtime/tool-catalogue.js";
import { BrowserWorker } from "./runtime/browser-worker.js";
import { ConcurrencyLimiter } from "./runtime/concurrency.js";
import { RateLimiter } from "./runtime/rate-limit.js";
import { bootHttpServer, type ServerHandle } from "./server/http.js";
import { DispatchPoller } from "./dispatch/poller.js";
import { WakeSocket } from "./dispatch/wake-socket.js";
import { SettingsStore } from "./settings/store.js";

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
  webhookStore: WebhookStore;
  webhookDispatcher: WebhookDispatcher;
  api: ApiClient;
  eventQueue: EventQueue;
  concurrency: ConcurrencyLimiter;
  license: LicenseManager;
  rateLimiter: RateLimiter;
  settings: SettingsStore;
}

/** Wire the dependency graph and start the local HTTP server. */
export async function startRunner(): Promise<Runner> {
  const cfg = loadConfig();
  const log = createLogger(cfg.logLevel);
  log.info({ cfg }, "starting runner");

  const secrets = new SecretStore(cfg.dataDir);
  const api = new ApiClient(cfg.apiBase, log);

  // Phase A: silent first-launch pairing. If a preauth token is sitting
  // in the env or as a marker file dropped by the installer/protocol
  // handler, redeem it before we touch tokens/license — that way the
  // tray icon goes from "Stopped" straight to "Running" without ever
  // displaying "Not paired".
  await maybeRedeemPreauth({ cfg, secrets, api, log });

  const pairing = new PairingService(cfg, secrets, api);
  const tokens = new TokenManager(api, pairing);
  const license = new LicenseManager(api, tokens, log);

  const credentials = new CredentialStore(paths(cfg).sqlite, secrets);
  await credentials.init();

  const settings = new SettingsStore(credentials.rawDb());
  settings.init();

  const workflowStore = new WorkflowStore(credentials.rawDb());
  workflowStore.init();
  const workflowSync = new WorkflowSync(api, tokens, workflowStore, log);

  const webhookStore = new WebhookStore(credentials.rawDb(), credentials.masterKey());
  webhookStore.init();
  const webhookDispatcher = new WebhookDispatcher(webhookStore, log);

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
  const rateLimiter = new RateLimiter();
  const localWorkflowRunner = new LocalWorkflowRunner(
    executor,
    catalogue,
    tokens,
    scratch,
    log,
    webhookDispatcher,
    workflowStore,
  );

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
    webhookStore,
    webhookDispatcher,
    eventQueue: queue,
    concurrency,
    license,
    rateLimiter,
    settings,
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
    poller = new DispatchPoller(
      cfg.apiBase,
      tokens,
      executor,
      scratch,
      api,
      log,
      webhookDispatcher,
    );
    poller.start();
    log.info({ apiBase: cfg.apiBase }, "auto-dispatch poller running");

    const wakeBase = process.env.JADAPPS_RUNNER_WSS_URL;
    if (wakeBase) {
      wakeSocket = new WakeSocket(wakeBase, tokens, () => poller!.kick(), log);
      wakeSocket.start();
      log.info({ wssUrl: wakeBase }, "wake socket enabled");
    }
  }

  const shutdown = makeShutdown(
    log,
    server,
    telemetry,
    workers,
    bundles,
    browserWorker,
    poller,
    wakeSocket,
    webhookDispatcher,
  );
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
    webhookStore,
    webhookDispatcher,
    api,
    eventQueue: queue,
    concurrency,
    license,
    rateLimiter,
    settings,
  };
}

/**
 * Look for a preauth token at boot and redeem it silently. Sources, in
 * priority order:
 *
 *   1. `JADAPPS_PREAUTH_TOKEN` env var (set by the installer / protocol
 *      handler before exec'ing the runner).
 *   2. `<dataDir>/preauth.json` marker file with shape
 *      `{ preauthToken, deviceName?, platformTag? }`. Companion-file
 *      delivery path used when protocol activation isn't wired.
 *
 * The token is consumed on success — env var is unset for the rest of
 * the process; marker file is deleted. Failures are logged but do NOT
 * abort startup; the runner just stays unpaired and the user can pair
 * later through the interactive flow.
 */
export async function maybeRedeemPreauth(deps: {
  cfg: ReturnType<typeof loadConfig>;
  secrets: SecretStore;
  api: ApiClient;
  log: ReturnType<typeof createLogger>;
}): Promise<void> {
  const markerPath = join(deps.cfg.dataDir, "preauth.json");
  let source: "env" | "file" | null = null;
  let token = (process.env.JADAPPS_PREAUTH_TOKEN ?? "").trim();
  let deviceName: string | undefined;
  let platformTag: string | undefined;

  if (token) {
    source = "env";
  } else if (existsSync(markerPath)) {
    try {
      const parsed = JSON.parse(readFileSync(markerPath, "utf8")) as {
        preauthToken?: unknown;
        deviceName?: unknown;
        platformTag?: unknown;
      };
      if (typeof parsed.preauthToken === "string" && parsed.preauthToken.trim()) {
        token = parsed.preauthToken.trim();
        source = "file";
        if (typeof parsed.deviceName === "string") deviceName = parsed.deviceName;
        if (typeof parsed.platformTag === "string") platformTag = parsed.platformTag;
      }
    } catch (err) {
      deps.log.warn(
        { err, markerPath },
        "preauth marker file present but unparseable; ignoring",
      );
    }
  }

  if (!token || !source) return;

  const redeemer = new PreauthRedeemer({
    cfg: deps.cfg,
    secrets: deps.secrets,
    api: deps.api,
    log: deps.log,
  });

  if (redeemer.isPaired()) {
    deps.log.info(
      { source },
      "preauth token present but runner already paired; consuming token without redeeming",
    );
    consumePreauthSource(source, markerPath);
    return;
  }

  try {
    const opts: { deviceName?: string; platformTag?: string } = {};
    if (deviceName) opts.deviceName = deviceName;
    if (platformTag) opts.platformTag = platformTag;
    const identity = await redeemer.redeem(token, opts);
    deps.log.info(
      { source, deviceId: identity.deviceId, userId: identity.userId },
      "silently paired via preauth token",
    );
    consumePreauthSource(source, markerPath);
  } catch (err) {
    deps.log.error(
      { err: (err as Error).message, source },
      "preauth redemption failed; runner will start unpaired",
    );
    // Always consume the token so we don't retry a known-bad token on
    // every restart. If the user wants to retry, they get a fresh token.
    consumePreauthSource(source, markerPath);
  }
}

function consumePreauthSource(source: "env" | "file", markerPath: string): void {
  if (source === "env") {
    delete process.env.JADAPPS_PREAUTH_TOKEN;
    return;
  }
  try {
    if (existsSync(markerPath)) unlinkSync(markerPath);
  } catch {
    // Best-effort; if we can't delete it the redeemer's isPaired() guard
    // will refuse to redeem on the next boot anyway.
  }
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
  webhookDispatcher: WebhookDispatcher,
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
      // Drain pending webhook deliveries before tearing down the HTTP
      // server — otherwise in-flight retries lose their store handle.
      await webhookDispatcher.flush().catch(() => undefined);
      await server.shutdown();
      await workers.shutdown();
      bundles.shutdown();
      await browserWorker.shutdown();
    } catch (err) {
      log.error({ err }, "error during shutdown");
    }
  };
}
