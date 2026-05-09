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
  .command("oauth2 <providerName> <ref>")
  .description("Run an OAuth2 PKCE flow and save the token under <ref> in the runner credential store.")
  .requiredOption("--client-id <id>", "OAuth2 client_id")
  .option("--client-secret <secret>", "OAuth2 client_secret (omit for public/PKCE-only clients)")
  .requiredOption("--auth-url <url>", "Authorization endpoint")
  .requiredOption("--token-url <url>", "Token endpoint")
  .option("--scope <scopes>", "Space-separated scopes", "")
  .option("--auth-style <style>", "client_secret_post (default) or client_secret_basic", "client_secret_post")
  .action(
    async (
      providerName: string,
      ref: string,
      opts: {
        clientId: string;
        clientSecret?: string;
        authUrl: string;
        tokenUrl: string;
        scope: string;
        authStyle: "client_secret_post" | "client_secret_basic";
      },
    ) => {
      const { runOAuth2Flow, storeOAuth2Credential } = await import("./auth/oauth2.js");
      const { CredentialStore } = await import("./credentials/store.js");
      const { paths: pathsFn } = await import("./config.js");
      const cfg = loadConfig();
      const log = createLogger(cfg.logLevel);
      const secrets = new SecretStore(cfg.dataDir);
      const store = new CredentialStore(pathsFn(cfg).sqlite, secrets);
      await store.init();

      try {
        const result = await runOAuth2Flow(
          {
            name: providerName,
            authorizationUrl: opts.authUrl,
            tokenUrl: opts.tokenUrl,
            clientId: opts.clientId,
            ...(opts.clientSecret ? { clientSecret: opts.clientSecret } : {}),
            scopes: opts.scope.split(/\s+/).filter(Boolean),
            authStyle: opts.authStyle,
          },
          log,
        );
        await storeOAuth2Credential(
          store,
          ref,
          {
            name: providerName,
            authorizationUrl: opts.authUrl,
            tokenUrl: opts.tokenUrl,
            clientId: opts.clientId,
            scopes: opts.scope.split(/\s+/).filter(Boolean),
          },
          result,
        );
        process.stdout.write(
          `\nStored OAuth2 token under credential ref "${ref}".\n` +
            (result.expiresAt ? `Expires at: ${new Date(result.expiresAt).toISOString()}\n` : "") +
            (result.refreshToken ? "Refresh token saved.\n" : "No refresh token returned.\n"),
        );
      } catch (err) {
        process.stderr.write(`\nOAuth2 flow failed: ${(err as Error).message}\n`);
        process.exitCode = 1;
      }
    },
  );

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

program
  .command("mcp")
  .description(
    "Run as an MCP server over stdio (for Claude Desktop / Cursor / IDE clients). " +
      "Reads JSON-RPC on stdin, writes on stdout; logs go to stderr only.",
  )
  .action(async () => {
    // Suppress all stdout writes from the runner boot — stdio is reserved for
    // MCP framing. Loggers write to stderr.
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
      // We re-enable stdout once the MCP transport claims it.
      void chunk;
      void rest;
      return true;
    }) as typeof process.stdout.write;

    const runner = await startRunner();

    // Restore stdout for the MCP transport.
    process.stdout.write = originalWrite;

    const { StdioServerTransport } = await import(
      "@modelcontextprotocol/sdk/server/stdio.js"
    );
    const { createMcpServer } = await import("./mcp/server.js");

    const mcpServer = createMcpServer({
      log: runner.log,
      executor: runner.executor,
      catalogue: runner.catalogue,
      tokens: runner.tokens,
      credentials: runner.credentials,
      scratch: runner.scratch,
      workflowStore: runner.workflowStore,
      workflowSync: runner.workflowSync,
      localWorkflowRunner: runner.localWorkflowRunner,
      api: runner.api,
      eventQueue: runner.eventQueue,
    });

    const transport = new StdioServerTransport();
    await mcpServer.connect(transport as unknown as Parameters<typeof mcpServer.connect>[0]);

    // Keep the process alive — stdio transport runs until EOF on stdin.
    process.on("SIGINT", () => {
      void runner.shutdown().then(() => process.exit(0));
    });
    process.on("SIGTERM", () => {
      void runner.shutdown().then(() => process.exit(0));
    });
  });

program
  .command("mcp-config")
  .description("Print a Claude Desktop config snippet for adding this runner.")
  .action(() => {
    const path = process.execPath;
    const snippet = {
      mcpServers: {
        jadapps: {
          command: path,
          args: [process.argv[1] ?? "jadapps-runner", "mcp"],
        },
      },
    };
    process.stdout.write(JSON.stringify(snippet, null, 2) + "\n");
    process.stdout.write(
      "\nPaste this into your Claude Desktop / Cursor MCP server config and restart the client.\n",
    );
  });

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`error: ${(err as Error).message}\n`);
  process.exit(1);
});
