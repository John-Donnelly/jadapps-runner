# Server contract for `@jadapps/runner` v0.1

The runner expects the following endpoints on the JAD Apps server. All routes
return JSON. Auth headers shown per route.

## Pairing

### `POST /api/runner/pair/begin`
Body: `{ pendingId, publicKey, code, deviceName }`
Response: `{ deepLink }` — URL the user opens (signed-in) to confirm pairing.

### `POST /api/runner/pair/poll`
Body: `{ pendingId }`
Response when not yet confirmed: `{ confirmed: false, deviceId: "", userId: "", refreshToken: "" }`
Response when confirmed: `{ confirmed: true, deviceId, userId, refreshToken }`

## Token exchange

### `POST /api/runner/token`
Body: `{ refreshToken, deviceId, ts, signature }`
- `signature` is base64 Ed25519 sig of `${deviceId}.${ts}` using the device's
  private key (server has the public key from pairing).
Response: `{ accessToken, expiresAt, tier, limits: { maxBytesPerRun, maxConcurrentRuns, monthlyByteBudget } }`

## Run lifecycle

### `POST /api/orchestrator/runs/preflight`
Auth: `Bearer <accessToken>`
Body: `{ workflowId, estimatedBytes }`
Response: full `RunToken` (see `src/types.ts`) including a `runToken.jwt` and
the per-step `tools[]` with bundle URLs and decryption keys.

### `POST /api/orchestrator/runs/:runId/events`
Auth: `Bearer <runToken.jwt>`
Body: `{ events: TelemetryEvent[] }`
Response: `{ revoked: boolean }` — runner aborts the run if revoked.

### `POST /api/orchestrator/runs/:runId/finalize`
Auth: `Bearer <runToken.jwt>`
Body: `{ steps: StepResult[], durationMs, bytesProcessed }`

### `POST /api/orchestrator/steps/execute`
Auth: `Bearer <runToken.jwt>`
Body: full `StepDescriptor`
Used only when a step's runtime is `runner-via-server` (server runs the
step on its end and returns the result; the runner becomes a transport).

## Bundle delivery

### `GET <bundleUrl>` (any host, typically a CDN signed URL)
Auth: `Bearer <accessToken>`
Response: raw bytes of the bundle envelope (JSON):
```
{ encrypted: false, toolId, code }                 // dev / free tier
{ encrypted: true,  toolId, blob }                 // paid tier; blob is AES-GCM
                                                   // ciphertext base64; key in
                                                   // RunToken.tools[i].decryptionKey
```
Decrypted form is always `{ toolId, code }` where `code` is an ESM module.
The module's default export is `(ctx: ToolContext) => Promise<StepResult>`.

## Anti-abuse hooks (server-side, not runner-visible)

- Reject `POST /events` whose cumulative bytes exceed the run's pre-approved
  budget; respond with `{ revoked: true }`.
- Issue access tokens with TTL ≤ 15 min.
- Track `last_used_at` on refresh tokens; revoke if unused for N days.
- Anomaly job: per-device monthly bytes vs `tier_at_pair` quota.
