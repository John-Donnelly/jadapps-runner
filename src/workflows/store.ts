import type Database from "better-sqlite3";

/**
 * Local workflow storage on the runner. The runner caches workflow graphs
 * locally so it can:
 *   1. Execute saved workflows offline (no roundtrip per run)
 *   2. Surface them to MCP clients (Phase 5) without depending on the website
 *   3. Drive the bidirectional sync that eventually pushes locally-created
 *      workflows back to the server as `visibility='private'`
 *
 * Schema lives in the same SQLite file as credentials + telemetry queue;
 * the WorkflowStore consumes a Database instance opened by CredentialStore.
 */

export type WorkflowOrigin = "server" | "local" | "fork";

export interface LocalWorkflow {
  /** UUID — matches the server workflow id when origin='server' or after sync. */
  id: string;
  name: string;
  description: string | null;
  /** WorkflowGraph as JSON (nodes + edges). */
  graph: Record<string, unknown>;
  /** Unix ms of last successful sync to/from server. null for unsynced local workflows. */
  serverSyncedAt: number | null;
  /** Unix ms of last local change. */
  localUpdatedAt: number;
  /** Where the workflow originated. */
  origin: WorkflowOrigin;
  isPrivate: boolean;
  /** Cron schedule string, mirrored from server when present. */
  scheduleCron: string | null;
}

export class WorkflowStore {
  constructor(private readonly db: Database.Database) {}

  init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS local_workflows (
        id                TEXT PRIMARY KEY,
        name              TEXT NOT NULL,
        description       TEXT,
        graph             TEXT NOT NULL,
        server_synced_at  INTEGER,
        local_updated_at  INTEGER NOT NULL,
        origin            TEXT NOT NULL DEFAULT 'server',
        is_private        INTEGER NOT NULL DEFAULT 1,
        schedule_cron     TEXT
      );
      CREATE INDEX IF NOT EXISTS local_workflows_origin_idx
        ON local_workflows (origin);
      CREATE INDEX IF NOT EXISTS local_workflows_unsynced_idx
        ON local_workflows (server_synced_at)
        WHERE server_synced_at IS NULL;
    `);
  }

  list(): LocalWorkflow[] {
    const rows = this.db
      .prepare(
        `SELECT id, name, description, graph, server_synced_at, local_updated_at,
                origin, is_private, schedule_cron
         FROM local_workflows
         ORDER BY local_updated_at DESC`,
      )
      .all() as RawRow[];
    return rows.map(rowToWorkflow);
  }

  get(id: string): LocalWorkflow | null {
    const row = this.db
      .prepare(
        `SELECT id, name, description, graph, server_synced_at, local_updated_at,
                origin, is_private, schedule_cron
         FROM local_workflows
         WHERE id = ?`,
      )
      .get(id) as RawRow | undefined;
    return row ? rowToWorkflow(row) : null;
  }

  /**
   * Insert or update a workflow. Used by both local CRUD endpoints and the
   * sync layer when pulling from the server.
   *
   * `localUpdatedAt` defaults to `Date.now()` so a sync pull doesn't make
   * the record look like a local change to subsequent push iterations.
   * Pass `markSynced: true` after a successful pull to also stamp
   * server_synced_at.
   */
  upsert(
    workflow: Omit<LocalWorkflow, "localUpdatedAt"> & { localUpdatedAt?: number },
    opts?: { markSynced?: boolean },
  ): LocalWorkflow {
    const now = Date.now();
    const localUpdatedAt = workflow.localUpdatedAt ?? now;
    const serverSyncedAt = opts?.markSynced ? now : workflow.serverSyncedAt ?? null;
    this.db
      .prepare(
        `INSERT INTO local_workflows
           (id, name, description, graph, server_synced_at, local_updated_at, origin, is_private, schedule_cron)
         VALUES
           (@id, @name, @description, @graph, @server_synced_at, @local_updated_at, @origin, @is_private, @schedule_cron)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           description = excluded.description,
           graph = excluded.graph,
           server_synced_at = excluded.server_synced_at,
           local_updated_at = excluded.local_updated_at,
           origin = excluded.origin,
           is_private = excluded.is_private,
           schedule_cron = excluded.schedule_cron`,
      )
      .run({
        id: workflow.id,
        name: workflow.name,
        description: workflow.description ?? null,
        graph: JSON.stringify(workflow.graph),
        server_synced_at: serverSyncedAt,
        local_updated_at: localUpdatedAt,
        origin: workflow.origin,
        is_private: workflow.isPrivate ? 1 : 0,
        schedule_cron: workflow.scheduleCron ?? null,
      });
    return this.get(workflow.id)!;
  }

  /** Mark a workflow as successfully synced to the server (push complete). */
  markSynced(id: string, syncedAt = Date.now()): void {
    this.db
      .prepare(`UPDATE local_workflows SET server_synced_at = ? WHERE id = ?`)
      .run(syncedAt, id);
  }

  /** Workflows with local changes that haven't been pushed yet. */
  pendingPush(): LocalWorkflow[] {
    const rows = this.db
      .prepare(
        `SELECT id, name, description, graph, server_synced_at, local_updated_at,
                origin, is_private, schedule_cron
         FROM local_workflows
         WHERE server_synced_at IS NULL
            OR local_updated_at > server_synced_at
         ORDER BY local_updated_at ASC`,
      )
      .all() as RawRow[];
    return rows.map(rowToWorkflow);
  }

  delete(id: string): boolean {
    return this.db.prepare(`DELETE FROM local_workflows WHERE id = ?`).run(id).changes > 0;
  }
}

interface RawRow {
  id: string;
  name: string;
  description: string | null;
  graph: string;
  server_synced_at: number | null;
  local_updated_at: number;
  origin: WorkflowOrigin;
  is_private: number;
  schedule_cron: string | null;
}

function rowToWorkflow(row: RawRow): LocalWorkflow {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    graph: JSON.parse(row.graph) as Record<string, unknown>,
    serverSyncedAt: row.server_synced_at,
    localUpdatedAt: row.local_updated_at,
    origin: row.origin,
    isPrivate: row.is_private === 1,
    scheduleCron: row.schedule_cron,
  };
}
