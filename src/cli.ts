#!/usr/bin/env node
import { Command } from "commander";
import { hostname } from "node:os";
import { loadConfig, paths } from "./config.js";
import { createLogger } from "./log.js";
import { SecretStore } from "./auth/keychain.js";
import { ApiClient } from "./api/client.js";
import { PairingService } from "./auth/pairing.js";
import { startRunner } from "./runner.js";

const program = new Command();
program
  .name("jadapps-runner")
  .description("JAD Apps local execution runner")
  .version("0.1.0");

program
  .command("start")
  .description("Start the local runner daemon (HTTP on loopback).")
  .option(
    "--auto-dispatch",
    "Poll the JAD Apps queue for cron/webhook-triggered runs and execute them inline (linear chains only).",
  )
  .action(async (opts: { autoDispatch?: boolean }) => {
    if (opts.autoDispatch) process.env.JADAPPS_RUNNER_AUTO_DISPATCH = "true";
    const runner = await startRunner();
    process.stdout.write(
      `\nRunner online at http://127.0.0.1:${runner.port}\n` +
        `Pairing token (paste into JAD Apps → Settings → Devices):\n  ${runner.pairingToken}\n` +
        (opts.autoDispatch
          ? `Auto-dispatch enabled — polling ${runner.apiBase} for queued runs.\n`
          : "") +
        `\nPress Ctrl+C to stop.\n`,
    );
    // Keep process alive on Windows where Fastify doesn't always block.
    await new Promise(() => {});
  });

program
  .command("status")
  .description("Print pairing + token status without starting the daemon.")
  .action(async () => {
    const cfg = loadConfig();
    const log = createLogger("warn");
    const secrets = new SecretStore(cfg.dataDir);
    const api = new ApiClient(cfg.apiBase, log);
    const pairing = new PairingService(cfg, secrets, api);
    const identity = pairing.loadIdentity();
    const refresh = await pairing.getRefreshToken();
    process.stdout.write(
      JSON.stringify(
        {
          paired: pairing.isPaired(),
          deviceId: identity?.deviceId ?? null,
          userId: identity?.userId ?? null,
          apiBase: cfg.apiBase,
          dataDir: cfg.dataDir,
          hasRefresh: !!refresh,
          fallbackKeychain: secrets.isUsingFallback(),
        },
        null,
        2,
      ) + "\n",
    );
  });

program
  .command("pair")
  .description("Begin the pairing flow with jadapps.app.")
  .option("-n, --name <name>", "Friendly device name", hostname())
  .option("--no-poll", "Just print the code; don't poll for confirmation")
  .action(async (opts: { name: string; poll: boolean }) => {
    const cfg = loadConfig();
    const log = createLogger(cfg.logLevel);
    const secrets = new SecretStore(cfg.dataDir);
    const api = new ApiClient(cfg.apiBase, log);
    const pairing = new PairingService(cfg, secrets, api);
    if (pairing.isPaired()) {
      process.stderr.write(
        "Runner is already paired. Run `jadapps-runner unpair` first.\n",
      );
      process.exitCode = 1;
      return;
    }

    const { code, deepLink } = await pairing.beginPairing(opts.name);
    process.stdout.write(
      `\nPairing code:  ${code}\n` +
        `Open this link while signed in to confirm:\n  ${deepLink}\n` +
        `\nWaiting for confirmation${opts.poll ? "" : " (skipped, --no-poll)"}…\n`,
    );

    if (opts.poll) {
      try {
        const id = await pairing.pollPairing();
        process.stdout.write(`\nPaired. deviceId=${id.deviceId} userId=${id.userId}\n`);
      } catch (err) {
        process.stderr.write(`\nPairing failed: ${(err as Error).message}\n`);
        process.exitCode = 1;
      }
    }
  });

program
  .command("unpair")
  .description("Remove this device's pairing record and stored credentials.")
  .action(async () => {
    const cfg = loadConfig();
    const log = createLogger("warn");
    const secrets = new SecretStore(cfg.dataDir);
    const api = new ApiClient(cfg.apiBase, log);
    const pairing = new PairingService(cfg, secrets, api);
    await pairing.unpair();
    process.stdout.write(`Unpaired. Data dir untouched at ${paths(cfg).pairing}\n`);
  });

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`error: ${(err as Error).message}\n`);
  process.exit(1);
});
