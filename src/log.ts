import pino from "pino";

/**
 * Phase 11 hardening — every log line passes through a redaction filter
 * so JWTs, API keys, OAuth tokens, and credential values can't accidentally
 * leak via debug log files (which users sometimes share for support).
 *
 * Pino's built-in `redact` config replaces matching paths with `[Redacted]`
 * before serialization. Coverage:
 *   - `*.jwt`, `*.accessToken`, `*.licenseToken`, `*.refreshToken`
 *   - `*.password`, `*.apiKey`, `*.api_key`, `*.bearer`
 *   - `*.privKey`, `*.privateKey`, `*.secret`, `*.token`
 *   - `*.signature` — pairing/device signatures
 *   - `headers.authorization` — Fastify request hooks log this otherwise
 *   - Anything inside `data` for credentials (matches our vault shape)
 *
 * The wildcard prefix `*.foo` matches the field at any depth in nested
 * objects, so callers don't need to flatten before logging.
 */
const REDACTED_PATHS = [
  "*.jwt",
  "*.accessToken",
  "*.access_token",
  "*.licenseToken",
  "*.license_token",
  "*.refreshToken",
  "*.refresh_token",
  "*.password",
  "*.apiKey",
  "*.api_key",
  "*.bearer",
  "*.privKey",
  "*.privateKey",
  "*.private_key",
  "*.secret",
  "*.token",
  "*.signature",
  "*.authorization",
  "data.*",
  "headers.authorization",
  "headers.cookie",
];

export function createLogger(level: string) {
  return pino({
    level,
    base: { name: "jadapps-runner" },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: REDACTED_PATHS,
      censor: "[Redacted]",
      remove: false,
    },
  });
}

export type Logger = ReturnType<typeof createLogger>;
