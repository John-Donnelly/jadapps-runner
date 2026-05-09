# JAD Apps Runner

Local execution runtime for [JAD Apps](https://jadapps.app). Runs file-processing tools, API connectors, and orchestrated workflows on your own machine — credentials never leave the device, and AI agents reach the platform through an [MCP](https://modelcontextprotocol.io) server bound to loopback.

```
@jadapps/runner ──┬── HTTP API on 127.0.0.1:9789 ── browser tab dispatches jobs here
                  ├── MCP server (stdio + /mcp)  ── Claude Desktop / Cursor / IDEs
                  └── Auto-dispatch poller       ── picks up cron + webhook-triggered runs
```

## Why run locally?

- **Native performance.** FFmpeg, Sharp, qpdf, Playwright — large jobs run at machine speed, not browser speed.
- **Credentials stay on your device.** API keys, OAuth tokens, and database connection strings live in the OS keychain (or 0600 files when unavailable). They're never synced to JAD's server.
- **Connectors that browsers can't host.** Postgres / MongoDB / Redis / SMTP and 30+ HTTP API connectors run as native code in the runner.
- **MCP for AI agents.** Point Claude Desktop, Cursor, or any MCP client at the runner to drive workflows from a chat.

## Install

```bash
npm install -g @jadapps/runner
```

Node 20.10 or newer is required. The runner ships as ESM.

## Quick start

```bash
# 1. Pair this device with your JAD account.
#    The CLI prints a one-time code and a deep link to confirm pairing
#    on jadapps.app/settings/runners.
jadapps-runner pair

# 2. Start the daemon. Binds to 127.0.0.1:9789 by default.
jadapps-runner start

# 3. (Optional) Print Claude Desktop / Cursor MCP config for this device.
jadapps-runner mcp-config
```

After pairing, the [JAD Apps web UI](https://jadapps.app) automatically routes runner-eligible tools to your local daemon.

## CLI reference

| Command | What it does |
| --- | --- |
| `jadapps-runner start` | Boot the HTTP server + auto-dispatch poller. |
| `jadapps-runner status` | Print pairing state, current tier, and recent run counts. |
| `jadapps-runner pair` | Run the device-pairing handshake against jadapps.app. |
| `jadapps-runner unpair` | Wipe the pairing record + stored credentials from this device. |
| `jadapps-runner oauth2 <provider> <ref>` | Run a PKCE OAuth flow and save the resulting token under `ref`. Supported providers include `google`, `github`, `slack`, `notion`, `dropbox`, `salesforce`, `xero`, and `microsoft`. |
| `jadapps-runner mcp` | Run as an MCP server on stdio (used by Claude Desktop's launcher). |
| `jadapps-runner mcp-config` | Emit a config snippet for Claude Desktop, Cursor, or any MCP client. |

Run any subcommand with `--help` for flags.

## MCP integration

The runner exposes an MCP server with 30+ tools covering workflow CRUD, tool execution, credential management, templates, triggers (cron + webhooks), and runner status. License-gated to Developer / Enterprise tiers.

**Claude Desktop** — drop the snippet `jadapps-runner mcp-config` produces into `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "jadapps": {
      "command": "jadapps-runner",
      "args": ["mcp"]
    }
  }
}
```

**Cursor** — same snippet, in `~/.cursor/mcp.json`.

**HTTP transport** — also available at `http://127.0.0.1:9789/mcp` (Streamable HTTP) for clients that prefer it. Bearer auth uses the local pairing token, never a JAD-server credential.

## Configuration

Set via environment variables (see `.env.example`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `JADAPPS_API_BASE` | `https://jadapps.app` | Server endpoint for pairing, token exchange, and bundle downloads. |
| `JADAPPS_RUNNER_HOST` | `127.0.0.1` | Bind address. **Don't change this** unless you really mean to expose the runner. |
| `JADAPPS_RUNNER_PORT` | `9789` | HTTP port. |
| `JADAPPS_RUNNER_DATA_DIR` | `~/.jadapps-runner` | Where SQLite + scratch files live. |
| `JADAPPS_RUNNER_LOG_LEVEL` | `info` | `trace` / `debug` / `info` / `warn` / `error`. |
| `JADAPPS_RUNNER_AUTO_DISPATCH` | `false` | Enable cron / queue claiming when set to `true`. |

## Security model

| Surface | What protects it |
| --- | --- |
| HTTP API (`/v1/*`, `/mcp`) | Bound to `127.0.0.1` only; Bearer pairing token required on every request. |
| Credentials | OS keychain (Keychain on macOS, Credential Manager on Windows, libsecret on Linux). 0600 file fallback when the OS keychain is unavailable. AES-256-GCM at rest. |
| Tool bundles | SHA-256 verified after download; encrypted bundles use AES-256-GCM with per-bundle keys delivered via run tokens. |
| Pairing | Ed25519 device key signs every token-exchange request. Server-side device revocation kills the runner within one access-token cycle (~15 min). |
| MCP / direct API | License-token gated. License is a separate JWT signed Ed25519 by the JAD license server; revocable per-device with hourly refresh. |
| Logs | Pino redaction strips JWTs, API keys, OAuth tokens, and credential values before serialization. |

The runner ships with no auto-update path — `npm update -g @jadapps/runner` (npm channel) or the signed installer (Tauri channel) is the only way new code reaches your machine.

## Development

```bash
git clone --recurse-submodules https://github.com/John-Donnelly/jadapps-runner.git
cd jadapps-runner
npm install
npm run dev          # tsx watcher
npm run build        # tsup → dist/
npm test             # vitest
npm run typecheck    # tsc --noEmit
```

The `src-tauri/` directory is a private submodule (`jadapps-runner-core`) holding the Rust core for the Tauri desktop shell — sidecar supervisor, AES-GCM/Ed25519 wire format, and license verifier. The Node sidecar in this repo runs standalone for npm-channel installs; the submodule is only required for local Tauri builds and is not necessary for contributing to the Node side.

If `git submodule update --init` fails because you don't have access to the private repo, you can still develop everything in `src/` — the submodule contents are only needed when running `npm run tauri:dev` or `npm run tauri:build`.

### Layout

```
src/
├── auth/             pairing, token exchange, license cache, OAuth2 PKCE
├── api/              outbound client to jadapps.app
├── builtin-connectors/  postgres, mongodb, redis, smtp (driver-dependent)
├── credentials/      AES-GCM SQLite vault
├── dispatch/         auto-dispatch poller + wake socket
├── mcp/              MCP server (stdio + HTTP), tools, resources, prompts
├── runtime/          executor, worker pool, browser worker, rate-limiter, tier-limits
├── server/           Fastify HTTP server + routes
├── telemetry/        event queue + flush client
├── webhooks/         outbound webhook dispatcher (workflow.run.complete, etc.)
└── workflows/        local workflow store, sync, linear runner
src-tauri/            Rust core (private submodule)
tests/                vitest specs
```

### Architectural contracts

`CONTRACTS.md` documents the wire formats the runner relies on (bundle envelopes, run tokens, credential vault, sync protocol). If you're touching anything that crosses the runner ↔ server or runner ↔ Tauri-core boundary, read that first.

## License

MIT. See [`LICENSE`](LICENSE) for the full text.

## Contributing

Issues and PRs welcome at [github.com/John-Donnelly/jadapps-runner](https://github.com/John-Donnelly/jadapps-runner). For changes touching wire formats or security-relevant code paths (auth, credentials, license verification), please open an issue first to discuss.
