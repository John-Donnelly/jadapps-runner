/**
 * Built-in Redis connector. Uses the `redis` driver from node_modules.
 *
 * Inputs (config object on ctx.inputs):
 *   action:        "get" | "set" | "del" | "lpush" | "lrange"
 *               | "hset" | "hget" | "hgetall" | "sadd" | "smembers"
 *               | "publish" | "keys"                              (required)
 *   key?:          string             — required for most actions
 *   value?:        string             — set / lpush / sadd / hset / publish
 *   field?:        string             — hset / hget
 *   ttlSec?:       number             — set with EX (seconds)
 *   start?:        number             — lrange (default 0)
 *   stop?:         number             — lrange (default -1)
 *   pattern?:      string             — keys (default "*"; use carefully on prod)
 *   channel?:      string             — publish
 *   credentialRef: string (required)  — runner credential (custom with url + optional password)
 *
 * Returns the value as `outputs.value` (string/number/array depending on action).
 */

import type { StepResult, Credential, FileRef } from "../types.js";

interface ToolContext {
  toolId: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRef[];
  credentials: Record<string, Credential>;
  scratchDir: string;
  emitProgress(bytes: number): void;
}

export default async function redisConnector(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const config = ctx.inputs;
  const action = String(config.action ?? "").trim();
  if (!action) return errorResult("missing_action", "redis requires `action`");

  const credentialRef = config.credentialRef as string | undefined;
  if (!credentialRef) {
    return errorResult(
      "missing_credential",
      "redis requires `credentialRef` (custom with url)",
    );
  }
  const credential = ctx.credentials[credentialRef];
  if (!credential) {
    return errorResult("credential_missing", `credential ${credentialRef} not found on runner`);
  }
  const url = credential.data.url as string | undefined;
  if (typeof url !== "string" || !url) {
    return errorResult(
      "bad_credential",
      `credential ${credentialRef} needs url (redis://… or rediss://…)`,
    );
  }
  const password = credential.data.password as string | undefined;

  let redisModule: typeof import("redis");
  try {
    redisModule = await import("redis");
  } catch (err) {
    return errorResult(
      "driver_missing",
      `redis driver not installed: ${(err as Error).message}`,
    );
  }
  const client = redisModule.createClient({
    url,
    ...(password ? { password } : {}),
    socket: { connectTimeout: 10_000, reconnectStrategy: false },
  });

  let bytes = 0;
  try {
    await client.connect();

    let value: unknown = null;

    switch (action) {
      case "get": {
        const key = requireKey(config.key);
        if (!key) return errorResult("missing_key", "get requires `key`");
        value = await client.get(key);
        break;
      }
      case "set": {
        const key = requireKey(config.key);
        const v = String(config.value ?? "");
        if (!key) return errorResult("missing_key", "set requires `key`");
        const ttlSec = Number(config.ttlSec);
        if (Number.isFinite(ttlSec) && ttlSec > 0) {
          value = await client.set(key, v, { EX: Math.floor(ttlSec) });
        } else {
          value = await client.set(key, v);
        }
        break;
      }
      case "del": {
        const key = requireKey(config.key);
        if (!key) return errorResult("missing_key", "del requires `key`");
        value = await client.del(key);
        break;
      }
      case "lpush": {
        const key = requireKey(config.key);
        const v = String(config.value ?? "");
        if (!key) return errorResult("missing_key", "lpush requires `key`");
        value = await client.lPush(key, v);
        break;
      }
      case "lrange": {
        const key = requireKey(config.key);
        if (!key) return errorResult("missing_key", "lrange requires `key`");
        const startIdx = Number(config.start ?? 0);
        const stopIdx = Number(config.stop ?? -1);
        value = await client.lRange(key, startIdx, stopIdx);
        break;
      }
      case "hset": {
        const key = requireKey(config.key);
        const field = requireKey(config.field);
        const v = String(config.value ?? "");
        if (!key || !field) {
          return errorResult("missing_fields", "hset requires `key` and `field`");
        }
        value = await client.hSet(key, field, v);
        break;
      }
      case "hget": {
        const key = requireKey(config.key);
        const field = requireKey(config.field);
        if (!key || !field) {
          return errorResult("missing_fields", "hget requires `key` and `field`");
        }
        value = await client.hGet(key, field);
        break;
      }
      case "hgetall": {
        const key = requireKey(config.key);
        if (!key) return errorResult("missing_key", "hgetall requires `key`");
        value = await client.hGetAll(key);
        break;
      }
      case "sadd": {
        const key = requireKey(config.key);
        const v = String(config.value ?? "");
        if (!key) return errorResult("missing_key", "sadd requires `key`");
        value = await client.sAdd(key, v);
        break;
      }
      case "smembers": {
        const key = requireKey(config.key);
        if (!key) return errorResult("missing_key", "smembers requires `key`");
        value = await client.sMembers(key);
        break;
      }
      case "publish": {
        const channel = requireKey(config.channel);
        const v = String(config.value ?? "");
        if (!channel) return errorResult("missing_channel", "publish requires `channel`");
        value = await client.publish(channel, v);
        break;
      }
      case "keys": {
        const pattern = String(config.pattern ?? "*");
        value = await client.keys(pattern);
        break;
      }
      default:
        return errorResult("unknown_action", `unknown redis action: ${action}`);
    }

    bytes = JSON.stringify(value).length;
    ctx.emitProgress(bytes);
    return {
      ok: true,
      outputs: { value },
      fileRefs: [],
      bytesProcessed: bytes,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const e = err as Error;
    return {
      ok: false,
      outputs: {},
      fileRefs: [],
      bytesProcessed: bytes,
      durationMs: Date.now() - start,
      error: { code: `redis_error`, message: e.message },
    };
  } finally {
    await client.quit().catch(() => undefined);
  }
}

function requireKey(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  return trimmed || null;
}

function errorResult(code: string, message: string): StepResult {
  return {
    ok: false,
    outputs: {},
    fileRefs: [],
    bytesProcessed: 0,
    durationMs: 0,
    error: { code, message },
  };
}
