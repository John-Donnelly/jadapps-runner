/**
 * Built-in MongoDB connector. Uses the `mongodb` driver from node_modules.
 *
 * Inputs (config object on ctx.inputs):
 *   action:        "findDocuments" | "findOne" | "insertDocument"
 *               | "updateDocument" | "deleteDocument" | "aggregation"
 *               | "countDocuments" | "listCollections"          (required)
 *   database:      string (required)
 *   collection?:   string             — required for all per-collection actions
 *   filter?:       object | string    — find/update/delete filter (Mongo query)
 *   document?:     object | string    — insertDocument body
 *   update?:       object | string    — updateDocument $set / $inc / etc.
 *   pipeline?:     object[] | string  — aggregation pipeline
 *   limit?:        number             — find cap (1-10000, default 100)
 *   sort?:         object | string    — find sort spec
 *   credentialRef: string (required)  — runner credential (custom with connectionString)
 *
 * Returns documents as `outputs.docs`, count as `outputs.count`.
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

export default async function mongodb(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const config = ctx.inputs;
  const action = String(config.action ?? "").trim();
  if (!action) return errorResult("missing_action", "mongodb requires `action`");

  const credentialRef = config.credentialRef as string | undefined;
  if (!credentialRef) {
    return errorResult(
      "missing_credential",
      "mongodb requires `credentialRef` (custom with connectionString)",
    );
  }
  const credential = ctx.credentials[credentialRef];
  if (!credential) {
    return errorResult("credential_missing", `credential ${credentialRef} not found on runner`);
  }
  const connectionString = credential.data.connectionString as string | undefined;
  if (typeof connectionString !== "string" || !connectionString) {
    return errorResult(
      "bad_credential",
      `credential ${credentialRef} needs connectionString (mongodb://… or mongodb+srv://…)`,
    );
  }

  const databaseName = String(config.database ?? "").trim();
  if (!databaseName) return errorResult("missing_database", "mongodb requires `database`");

  let mongoModule: typeof import("mongodb");
  try {
    mongoModule = await import("mongodb");
  } catch (err) {
    return errorResult(
      "driver_missing",
      `mongodb driver not installed: ${(err as Error).message}`,
    );
  }
  const { MongoClient } = mongoModule;

  const client = new MongoClient(connectionString, {
    serverSelectionTimeoutMS: 10_000,
  });
  let bytes = 0;
  try {
    await client.connect();
    const db = client.db(databaseName);

    switch (action) {
      case "listCollections": {
        const cols = await db.listCollections().toArray();
        bytes = JSON.stringify(cols).length;
        ctx.emitProgress(bytes);
        return ok(start, bytes, { collections: cols, count: cols.length });
      }
      case "findDocuments": {
        const collectionName = requireCollection(config.collection);
        if (!collectionName) {
          return errorResult("missing_collection", "findDocuments requires `collection`");
        }
        const filter = parseObject(config.filter) ?? {};
        const limit = clampInt(config.limit, 1, 10000, 100);
        const sort = parseObject(config.sort);
        const cursor = db.collection(collectionName).find(filter);
        if (sort && Object.keys(sort).length > 0) {
          cursor.sort(sort as { [key: string]: 1 | -1 });
        }
        const docs = await cursor.limit(limit).toArray();
        bytes = JSON.stringify(docs).length;
        ctx.emitProgress(bytes);
        return ok(start, bytes, { docs, count: docs.length });
      }
      case "findOne": {
        const collectionName = requireCollection(config.collection);
        if (!collectionName) {
          return errorResult("missing_collection", "findOne requires `collection`");
        }
        const filter = parseObject(config.filter) ?? {};
        const doc = await db.collection(collectionName).findOne(filter);
        bytes = JSON.stringify(doc).length;
        ctx.emitProgress(bytes);
        return ok(start, bytes, { doc });
      }
      case "insertDocument": {
        const collectionName = requireCollection(config.collection);
        const document = parseObject(config.document);
        if (!collectionName || !document) {
          return errorResult(
            "missing_fields",
            "insertDocument requires `collection` and `document`",
          );
        }
        const r = await db.collection(collectionName).insertOne(document);
        return ok(start, 0, { insertedId: r.insertedId, acknowledged: r.acknowledged });
      }
      case "updateDocument": {
        const collectionName = requireCollection(config.collection);
        const filter = parseObject(config.filter);
        const update = parseObject(config.update);
        if (!collectionName || !filter || !update) {
          return errorResult(
            "missing_fields",
            "updateDocument requires `collection`, `filter`, and `update` (with $set/$inc/etc.)",
          );
        }
        const r = await db.collection(collectionName).updateMany(filter, update);
        return ok(start, 0, {
          matchedCount: r.matchedCount,
          modifiedCount: r.modifiedCount,
          upsertedCount: r.upsertedCount,
        });
      }
      case "deleteDocument": {
        const collectionName = requireCollection(config.collection);
        const filter = parseObject(config.filter);
        if (!collectionName || !filter) {
          return errorResult(
            "missing_fields",
            "deleteDocument requires `collection` and `filter`",
          );
        }
        const r = await db.collection(collectionName).deleteMany(filter);
        return ok(start, 0, { deletedCount: r.deletedCount });
      }
      case "aggregation": {
        const collectionName = requireCollection(config.collection);
        const pipeline = parseList(config.pipeline);
        if (!collectionName || !pipeline) {
          return errorResult(
            "missing_fields",
            "aggregation requires `collection` and `pipeline` (array)",
          );
        }
        const docs = await db.collection(collectionName).aggregate(pipeline as object[]).toArray();
        bytes = JSON.stringify(docs).length;
        ctx.emitProgress(bytes);
        return ok(start, bytes, { docs, count: docs.length });
      }
      case "countDocuments": {
        const collectionName = requireCollection(config.collection);
        if (!collectionName) {
          return errorResult("missing_collection", "countDocuments requires `collection`");
        }
        const filter = parseObject(config.filter) ?? {};
        const count = await db.collection(collectionName).countDocuments(filter);
        return ok(start, 0, { count });
      }
      default:
        return errorResult("unknown_action", `unknown mongodb action: ${action}`);
    }
  } catch (err) {
    const e = err as Error & { code?: string | number };
    return {
      ok: false,
      outputs: {},
      fileRefs: [],
      bytesProcessed: bytes,
      durationMs: Date.now() - start,
      error: { code: `mongo_${e.code ?? "error"}`, message: e.message },
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

function ok(
  start: number,
  bytes: number,
  outputs: Record<string, unknown>,
): StepResult {
  return {
    ok: true,
    outputs,
    fileRefs: [],
    bytesProcessed: bytes,
    durationMs: Date.now() - start,
  };
}

function requireCollection(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  return trimmed || null;
}

function parseObject(input: unknown): Record<string, unknown> | null {
  if (input == null) return null;
  if (typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? parsed
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

function parseList(input: unknown): unknown[] | null {
  if (input == null) return null;
  if (Array.isArray(input)) return input;
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.floor(n)));
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
