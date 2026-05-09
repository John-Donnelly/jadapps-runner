/**
 * Built-in PostgreSQL connector. Uses the `pg` driver from the runner's
 * node_modules (loaded dynamically so the import doesn't fail in environments
 * where pg isn't installed — e.g. type-checking tests on a fresh clone).
 *
 * Inputs (config object on ctx.inputs):
 *   action:        "executeQuery" | "insertRow" | "updateRow" | "deleteRow"
 *                | "callFunction" | "describeTable" | "listTables"   (required)
 *   sql?:          string             — raw SQL for executeQuery
 *   params?:       unknown[] | string — parameterised values ($1, $2, ...)
 *   table?:        string             — for insert/update/delete/describe
 *   row?:          object | string    — insert/update payload
 *   where?:        string             — update/delete WHERE clause (parameterised)
 *   functionName?: string             — callFunction
 *   functionArgs?: unknown[] | string — callFunction positional args
 *   credentialRef: string (required)  — runner credential (custom with connectionString)
 *
 * Returns rows as `outputs.rows`, count as `outputs.rowCount`.
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

export default async function postgres(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const config = ctx.inputs;
  const action = String(config.action ?? "").trim();
  if (!action) return errorResult("missing_action", "postgres requires `action`");

  const credentialRef = config.credentialRef as string | undefined;
  if (!credentialRef) {
    return errorResult(
      "missing_credential",
      "postgres requires `credentialRef` (custom with connectionString)",
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
      `credential ${credentialRef} needs connectionString (postgres://…)`,
    );
  }

  let pg: typeof import("pg");
  try {
    pg = await import("pg");
  } catch (err) {
    return errorResult(
      "driver_missing",
      `pg driver not installed: ${(err as Error).message}. Run npm i pg in the runner package.`,
    );
  }

  const client = new pg.default.Client({ connectionString });
  let bytes = 0;
  try {
    await client.connect();

    let result: { rows: unknown[]; rowCount: number | null } = { rows: [], rowCount: null };

    switch (action) {
      case "executeQuery": {
        const sql = String(config.sql ?? "").trim();
        if (!sql) return errorResult("missing_sql", "executeQuery requires `sql`");
        const params = parseList(config.params);
        const r = await client.query(sql, params ?? []);
        result = { rows: r.rows, rowCount: r.rowCount };
        break;
      }
      case "insertRow": {
        const table = identifier(config.table);
        const row = parseObject(config.row);
        if (!table || !row) {
          return errorResult("missing_fields", "insertRow requires `table` and `row` (object)");
        }
        const cols = Object.keys(row);
        const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
        const sql = `INSERT INTO ${table} (${cols.map(quoteIdent).join(", ")}) VALUES (${placeholders}) RETURNING *`;
        const r = await client.query(sql, cols.map((c) => row[c]));
        result = { rows: r.rows, rowCount: r.rowCount };
        break;
      }
      case "updateRow": {
        const table = identifier(config.table);
        const row = parseObject(config.row);
        const where = String(config.where ?? "").trim();
        if (!table || !row || !where) {
          return errorResult(
            "missing_fields",
            "updateRow requires `table`, `row`, and `where` (parameterised, e.g. \"id = $${N+1}\")",
          );
        }
        const cols = Object.keys(row);
        const setClause = cols.map((c, i) => `${quoteIdent(c)} = $${i + 1}`).join(", ");
        const sql = `UPDATE ${table} SET ${setClause} WHERE ${where} RETURNING *`;
        const params = parseList(config.params) ?? [];
        const r = await client.query(sql, [...cols.map((c) => row[c]), ...params]);
        result = { rows: r.rows, rowCount: r.rowCount };
        break;
      }
      case "deleteRow": {
        const table = identifier(config.table);
        const where = String(config.where ?? "").trim();
        if (!table || !where) {
          return errorResult("missing_fields", "deleteRow requires `table` and `where`");
        }
        const sql = `DELETE FROM ${table} WHERE ${where}`;
        const params = parseList(config.params) ?? [];
        const r = await client.query(sql, params);
        result = { rows: r.rows, rowCount: r.rowCount };
        break;
      }
      case "callFunction": {
        const fn = String(config.functionName ?? "").trim();
        if (!fn) return errorResult("missing_function", "callFunction requires `functionName`");
        const args = parseList(config.functionArgs) ?? [];
        const placeholders = args.map((_, i) => `$${i + 1}`).join(", ");
        const sql = `SELECT * FROM ${quoteIdent(fn)}(${placeholders})`;
        const r = await client.query(sql, args);
        result = { rows: r.rows, rowCount: r.rowCount };
        break;
      }
      case "describeTable": {
        const table = String(config.table ?? "").trim();
        if (!table) return errorResult("missing_table", "describeTable requires `table`");
        const r = await client.query(
          `SELECT column_name, data_type, is_nullable, column_default
           FROM information_schema.columns
           WHERE table_name = $1
           ORDER BY ordinal_position`,
          [table],
        );
        result = { rows: r.rows, rowCount: r.rowCount };
        break;
      }
      case "listTables": {
        const r = await client.query(
          `SELECT table_name FROM information_schema.tables
           WHERE table_schema = 'public' ORDER BY table_name`,
        );
        result = { rows: r.rows, rowCount: r.rowCount };
        break;
      }
      default:
        return errorResult("unknown_action", `unknown postgres action: ${action}`);
    }

    bytes = JSON.stringify(result.rows).length;
    ctx.emitProgress(bytes);

    return {
      ok: true,
      outputs: {
        rows: result.rows,
        rowCount: result.rowCount ?? result.rows.length,
      },
      fileRefs: [],
      bytesProcessed: bytes,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const e = err as Error & { code?: string };
    return {
      ok: false,
      outputs: {},
      fileRefs: [],
      bytesProcessed: bytes,
      durationMs: Date.now() - start,
      error: { code: `pg_${e.code ?? "error"}`, message: e.message },
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Validates a table reference. Allows schema-qualified names like "public.users"
 * by quoting each segment independently. Rejects anything with disallowed chars.
 */
function identifier(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (!/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(trimmed)) return null;
  return trimmed.split(".").map(quoteIdent).join(".");
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
