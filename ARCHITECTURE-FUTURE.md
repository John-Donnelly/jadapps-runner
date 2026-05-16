# Future architecture: ECSIE + MCP orchestrator

> **Status:** design only. No code in `src/` implements ECSIE or the
> MCP orchestrator yet. This document fixes the seams and the
> contracts so the implementations can land later without touching
> `runner.ts`, `cli.ts`, or `tauri.conf.json` again.

## 1. Scope

Two future capabilities, both license-gated, both running locally:

| Capability | What it is | Why local |
|---|---|---|
| **ECSIE core** | Inference engine that runs as a workflow tool **and** as an interactive chat agent embedded in the (eventual) full UI. | Cuts cloud GPU spend, keeps prompts on-device, lets workflows compose inference + connectors without leaving the runner. |
| **MCP server orchestrator** | A supervisor that hosts more MCP servers than the built-in JAD MCP — user-configured (filesystem, postgres, custom). The runner becomes a hub for all the user's MCP servers, not just JAD's. | Single licensed surface for all MCP clients (Claude Desktop, Cursor, IDE plugins) without each client maintaining its own list. |

Both ship after WinUI3 parity (Phase C). The plan below assumes
that's done — i.e. the WinUI3 host owns the visible UI on Windows
and the Tauri host owns the visible UI on macOS/Linux. Where the
two hosts diverge, this document specifies both.

## 2. ECSIE core

### 2.1 Process model

ECSIE runs as a **sibling sidecar to Node**, spawned and supervised
by the host shell (WinUI3 or Tauri), **not** by Node. The reasons:

- ECSIE owns a GPU/CPU pool that must outlive Node restarts (Node
  crashes ~once a year, an ECSIE process warm-up is 5–15s, model
  load can be minutes).
- The host already has supervisor + log-piping logic; adding ECSIE
  alongside Node reuses it rather than reinventing it.
- The orchestrator/chat UI on the host needs direct access to the
  inference stream — going Node→ECSIE for every token would double
  the latency for no gain.

```
                 ┌──── Node sidecar (HTTP 9789)
host shell ─────┤
                 └──── ECSIE sidecar (HTTP 9790, gRPC optional)
```

### 2.2 Wire contract

`ECSIE_PORT` defaults to 9790, bound to 127.0.0.1 only. Three
endpoints, all `Bearer <token>` authenticated:

```
POST /v1/infer           — non-stream JSON completion
POST /v1/infer/stream    — SSE token stream
GET  /v1/models          — list loaded models, free VRAM, queue depth
```

Auth token is **separate from** the runner pairing token — minted by
Node at boot and handed to ECSIE via env var (`ECSIE_AUTH_TOKEN`).
Reasons:

- A compromised JAD pairing token would otherwise unlock inference.
- ECSIE may be invoked from non-Node clients (the WinUI3 chat panel)
  that don't have the pairing token.
- Rotating one without the other is straightforward.

Request payload mirrors the Anthropic Messages API surface for
familiarity:

```jsonc
{
  "model": "ecsie-local-7b-instruct",
  "messages": [{ "role": "user", "content": "…" }],
  "max_tokens": 1024,
  "temperature": 0.2,
  "tools": [/* MCP tools the orchestrator advertises */],
  "metadata": { "runId": "uuid", "workflowId": "uuid" }
}
```

### 2.3 Integration with the Node executor

A new connector at `src/builtin-connectors/ecsie-infer.ts` exposes
ECSIE as a workflow tool (`tool_id = "ecsie.infer"`). Inputs map
1:1 to the wire contract above. The connector:

- Checks `LicenseManager.hasFeature("ecsie")` at the top — refuses
  with a 402-style error if not licensed.
- Forwards the call to `http://127.0.0.1:9790/v1/infer` with the
  shared `ECSIE_AUTH_TOKEN`.
- Streams tokens back through the executor's event channel so the
  website can render them live (same path as `executor.execute`'s
  telemetry events).

### 2.4 License gating

Add `"ecsie"` to the features union in
[src/auth/license.ts](src/auth/license.ts#L32). The server-side
issuer should treat ECSIE as Enterprise-tier-only initially; relax
later. The MCP server boot gate at
[src/mcp/server.ts](src/mcp/server.ts) gains a parallel
`checkEcsieLicense()` that the chat UI consults before opening the
connection.

### 2.5 UI seam (post-WinUI3-Phase-C)

The full UI's "Chat" panel is a XAML page that talks to
`http://127.0.0.1:9790/v1/infer/stream` directly. It does NOT proxy
through Node. The chat panel's "Available tools" list comes from
the MCP orchestrator (next section) — that's the link between the
two capabilities.

## 3. MCP server orchestrator

### 3.1 What it does

The current runner exposes **one** MCP server: the built-in JAD one
defined in `src/mcp/server.ts`. The orchestrator generalises this:
it spawns and supervises N MCP server processes (the user's
filesystem, postgres, brave-search, custom Python, etc.) and
multiplexes their tools/resources into a single MCP surface that
external clients (Claude Desktop, Cursor) consume.

```
                                             ┌── jad-mcp-server (in-process)
external MCP client ── orchestrator (9789) ──┼── filesystem-mcp (stdio child)
                                             ├── postgres-mcp     (stdio child)
                                             └── custom-py-mcp    (stdio child)
```

### 3.2 Process model

Lives **inside Node** (not as a separate sidecar). MCP servers are
typically stdio-driven and cheap to spawn — running them under
Node's existing executor + scratch pool reuses the supervision,
metrics, and log-piping we already have. ECSIE is the exception
(GPU-bound, model-load latency); MCP servers are the rule (sub-100ms
spawn, no persistent state).

### 3.3 Configuration

User-editable JSON at `<dataDir>/mcp-servers.json`:

```jsonc
{
  "version": 1,
  "servers": [
    {
      "id": "filesystem",                            // stable id, used as tool prefix
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/docs"],
      "env": { "READ_ONLY": "1" },
      "enabled": true
    },
    {
      "id": "postgres",
      "transport": "stdio",
      "command": "uvx",
      "args": ["mcp-server-postgres"],
      "env": { "DATABASE_URL_REF": "creds.postgres-main" },  // ← runner credential ref
      "enabled": false
    }
  ]
}
```

`DATABASE_URL_REF` (and similar `*_REF` keys) are dereferenced at
spawn time against the credential vault. That way the JSON never
holds secrets directly — same model as the workflow runner.

### 3.4 Tool namespacing

Sub-server tools surface as `<server-id>.<tool>`:

```
filesystem.read_file
filesystem.list_directory
postgres.query
postgres.list_tables
jad.workflow_run            ← existing built-in
jad.tool_run                ← existing built-in
```

Naming collisions are impossible by construction (`server-id` is
mandatory and unique). Tool descriptions get prefixed too so users
know which server they're calling.

### 3.5 License gating

`mcp.orchestrator` as a sub-feature of `mcp`. Enterprise
required to host >1 server; Developer tier sees only the built-in
JAD server (matches today's behaviour, no breaking change).

### 3.6 UI seam

Settings page in the host:

```
┌─ MCP Servers ───────────────────────────────────┐
│ ☑ filesystem         /Users/me/docs    [Edit] │
│ ☐ postgres           (disabled)        [Edit] │
│ ☑ jad (built-in)                              │
│                                  [+ Add server] │
└─────────────────────────────────────────────────┘
```

Reads/writes `<dataDir>/mcp-servers.json` over a new
`GET/PATCH /v1/mcp-servers` route (parallels `/v1/settings` from
Phase B). Live reload on PATCH — orchestrator gracefully restarts
the affected sub-server.

## 4. Workflow integration

A new graph node type `mcp-call`:

```jsonc
{
  "type": "mcp-call",
  "server": "filesystem",
  "tool": "read_file",
  "inputs": { "path": "$inputs.file" }
}
```

The executor recognises `mcp-call` nodes and routes through the
orchestrator (`McpOrchestrator.callTool(server, tool, inputs)`).
Output JSON flows into the next step's inputs unchanged — the
orchestrator handles the JSON-RPC framing.

This is what closes the loop: workflow → mcp-call → external MCP
server (e.g. filesystem read) → ECSIE infer → connector send. All
local, all license-gated.

## 5. Seams to add now (zero implementation cost)

These changes are cheap, decoupled, and let the future work slot
in without touching the runner boot graph again. **Recommended
to land before Phase C.**

### 5.1 License feature flags

```diff
- features: ("mcp" | "api" | "workflow")[];
+ features: ("mcp" | "api" | "workflow" | "ecsie" | "mcp-orchestrator")[];
```

The server can start issuing these in tokens before the runner
implements them — `hasFeature("ecsie")` just returns false until
the capability ships.

### 5.2 Env vars

Add to [src/config.ts](src/config.ts):

```ts
ecsiePort: Number(process.env.JADAPPS_RUNNER_ECSIE_PORT ?? 0),         // 0 = disabled
orchestratorEnabled: process.env.JADAPPS_RUNNER_ORCH_ENABLED === "true",
```

Reserved namespace; no behavioural change until the runtime is wired.

### 5.3 Reserved HTTP routes

Mount `/v1/ecsie/*` and `/v1/mcp-servers/*` as 501 handlers with
`{ error: "not_implemented", docs: "ARCHITECTURE-FUTURE.md" }`.
Clients that probe for the capability get a clear answer instead
of a 404 they have to interpret.

## 6. Open questions

1. **GPU detection in WinUI3** — should the host probe DirectML /
   CUDA / Vulkan and pass capability flags to ECSIE on spawn? Yes,
   but the protocol for that goes in a separate design doc — keeps
   this one focused on lifecycle + wire.
2. **Model storage** — local model files can be 10–50GB each. They
   need their own settings entry (`modelStorageDir`) similar to
   `outputDir`. Add when ECSIE lands.
3. **Concurrent inference** — the existing
   [src/runtime/concurrency.ts](src/runtime/concurrency.ts)
   semaphore is per-user. ECSIE inference is per-model. New
   semaphore needed, scoped on `(userSub, modelId)`.
4. **MCP server credentials** — should an MCP server be able to ask
   the runner for a credential via a new MCP method, instead of
   getting an env-var-injected ref? Cleaner but a wire-protocol
   extension. Defer.

## 7. Non-goals (explicit)

- Multi-tenant runner. The runner stays single-user. If you need
  multi-user, run multiple runners.
- Cloud fallback for ECSIE. If the user wants cloud inference, they
  call Anthropic / OpenAI via the existing HTTP connectors.
- Hot-swapping ECSIE models from a workflow step. Too easy to
  thrash GPU memory; do it from the UI, persist the choice, then
  reference the loaded model by name.
- Cross-runner orchestration. One runner per machine, period.
