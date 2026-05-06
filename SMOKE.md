# Smoke recipe — full runner pipeline locally

End-to-end check that the runner authenticates, executes a workflow, and
streams results to/from JAD Apps. Takes 5–10 minutes the first time.

## Prerequisites

- Node ≥20.10
- A JAD Apps account signed in at <https://jadapps.app>
- Pro tier or higher (the connector tools require it)
- The runner installed locally (`npm install` once in this repo, or
  `npm install -g @jadapps/runner` once we publish)

## 1. Pair the runner

```sh
node dist/cli.js pair --name "$(hostname) (smoke)"
```

Open the printed deep link while signed in to JAD Apps; click **Confirm
pairing**. The CLI confirms within a few seconds.

Verify:

```sh
node dist/cli.js status
# { "paired": true, "deviceId": "…", "userId": "you@…" }
```

## 2. Start the runner

```sh
node dist/cli.js start
```

Copy the **pairing token** the CLI prints. In the orchestrator's status
pill (top-right of <https://jadapps.app/orchestrator>), paste it. The
pill turns green within a few seconds.

## 3. Build a one-step "Hello, runner" workflow

In <https://jadapps.app/orchestrator>:

1. Drag a **CSV Anonymizer** node onto the canvas
2. Click **Run**
3. Pick a CSV (any file with `email`, `phone`, `name` columns will
   demonstrate auto-detection — the [`tests/anonymize-bundle.test.ts`
   fixtures][1] are good)
4. Hit **Run**

The runner:
- preflights with the JAD Apps server,
- downloads the encrypted bundle metadata for `csv-anonymize`,
- spawns a worker, streams the file through, hashes the PII columns,
  emits a new CSV in scratch,
- streams it back to the browser via `/v1/runs/:id/files/:ref`.

The browser shows a download button for `anonymized.csv`.

[1]: ./tests/anonymize-bundle.test.ts

## 4. Add a credential, post to Slack

In <https://jadapps.app/settings/runner-credentials>:

1. **Add → API Key**, ref = `slack-bot`, value = `xoxb-…` (a Slack bot token with `chat:write`)
2. Back in the orchestrator, drop a **Slack: Post Message** node
3. Channel: `#general`, credentialRef: `slack-bot`, leave text empty
4. Wire CSV Anonymizer's output to Slack's input
5. Run again

Slack receives a message containing the head of the anonymized CSV.

## 5. Auto-dispatch (cron / webhook)

Restart the runner with `--auto-dispatch`:

```sh
node dist/cli.js start --auto-dispatch
```

In `/orchestrator/<workflowId>/triggers`:

- **Schedule**: `*/5 * * * *` (every 5 min)
- Or **New webhook** → copy the URL → `curl -X POST <url>` from elsewhere

Within ~10 seconds of a queue row landing, the runner claims and
executes the workflow without you touching the browser. Watch the
runner log for `dispatching claimed run` then `run complete`.

## What you've just verified

- Pairing handshake (Ed25519 device key, refresh + access JWTs)
- Encrypted credential vault (OS keychain master key + AES-GCM SQLite)
- Bundle delivery (sha-pinned, tier-gated)
- Worker pool with per-job scratch
- Streaming I/O for files larger than browser memory
- Disk pre-flight (peak vs free)
- Telemetry (heartbeat events + budget enforcement)
- Auto-dispatch loop (atomic claim + linear chain execution)

If any step fails, the runner log usually has the answer. The most
common gotchas:

- **`401 invalid pairing token`** in the orchestrator pill → re-paste
  the token from the runner's `start` output.
- **`tool not permitted on tier free`** → upgrade the account or use
  `csv-row-count` (free tier).
- **`runner offline`** in the chrome → the orchestrator can't reach
  `127.0.0.1:49217`. On Linux/WSL check that the runner is bound to a
  reachable interface (default is loopback).
