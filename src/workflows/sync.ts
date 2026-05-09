import type { ApiClient, RemoteWorkflowRow } from "../api/client.js";
import type { TokenManager } from "../auth/tokens.js";
import type { Logger } from "../log.js";
import type { WorkflowStore, LocalWorkflow } from "./store.js";

/**
 * Bidirectional workflow sync. The runner owns the cycle — the server is a
 * passive store. We never accept push from the server.
 *
 *   Pull (server → local):
 *     For every remote row whose updated_at > local.serverSyncedAt,
 *     upsert into local_workflows and stamp serverSyncedAt = now.
 *
 *   Push (local → server):
 *     For every local row with localUpdatedAt > serverSyncedAt (or null),
 *     PATCH the server (or POST if origin='local' and id is unknown).
 *
 *   Conflicts: server wins on overlapping fields (we always pull before push).
 *   Local-only drafts (origin='local' with no server record yet) become
 *   `visibility='private'` on first push.
 */

export interface SyncResult {
  pulled: number;
  pushed: number;
  errors: Array<{ id: string; phase: "pull" | "push"; message: string }>;
  durationMs: number;
}

export class WorkflowSync {
  private inflight: Promise<SyncResult> | null = null;

  constructor(
    private readonly api: ApiClient,
    private readonly tokens: TokenManager,
    private readonly store: WorkflowStore,
    private readonly log: Logger,
  ) {}

  /**
   * Run a full sync cycle. If one is already running, returns the same
   * promise so concurrent callers (boot + manual trigger) coalesce.
   */
  async sync(): Promise<SyncResult> {
    if (this.inflight) return this.inflight;
    this.inflight = this.runCycle().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async runCycle(): Promise<SyncResult> {
    const start = Date.now();
    const errors: SyncResult["errors"] = [];
    let pulled = 0;
    let pushed = 0;

    let accessJwt: string;
    try {
      const access = await this.tokens.getAccessToken();
      accessJwt = access.jwt;
    } catch (err) {
      this.log.warn({ err }, "workflow sync skipped — runner unpaired");
      return { pulled, pushed, errors, durationMs: Date.now() - start };
    }

    // ─── PULL ─────────────────────────────────────────────────────────────
    let remote: RemoteWorkflowRow[];
    try {
      remote = await this.api.listServerWorkflows(accessJwt);
    } catch (err) {
      this.log.warn({ err }, "workflow sync pull failed");
      return {
        pulled,
        pushed,
        errors: [{ id: "*", phase: "pull", message: (err as Error).message }],
        durationMs: Date.now() - start,
      };
    }

    for (const row of remote) {
      try {
        const local = this.store.get(row.id);
        const remoteTs = Date.parse(row.updated_at);
        if (local && local.serverSyncedAt != null && remoteTs <= local.serverSyncedAt) {
          continue; // already in sync
        }
        // If local has unsynced changes, the push half will handle them.
        // For now, server wins on overlapping fields when the remote record
        // is newer than what we last saw.
        if (local && local.localUpdatedAt > (local.serverSyncedAt ?? 0) && remoteTs <= local.localUpdatedAt) {
          continue; // local is newer → push will handle
        }
        this.store.upsert(
          {
            id: row.id,
            name: row.name,
            description: row.description ?? null,
            graph: row.graph,
            origin: local?.origin === "local" ? "local" : "server",
            isPrivate: row.visibility === "private",
            scheduleCron: row.schedule_cron,
            serverSyncedAt: Date.now(),
            // Match local_updated_at to remote so subsequent push iterations
            // don't see the upsert as a local change.
            localUpdatedAt: remoteTs,
          },
        );
        pulled++;
      } catch (err) {
        errors.push({ id: row.id, phase: "pull", message: (err as Error).message });
      }
    }

    // ─── PUSH ─────────────────────────────────────────────────────────────
    const pending = this.store.pendingPush();
    for (const local of pending) {
      try {
        if (local.origin === "local" && local.serverSyncedAt == null) {
          // Brand-new local workflow — create it on the server.
          const created = await this.api.createServerWorkflow(accessJwt, {
            name: local.name,
            description: local.description ?? "",
            graph: local.graph,
            scheduleCron: local.scheduleCron ?? null,
            visibility: local.isPrivate ? "private" : "team",
          });
          // Server assigned a new id — replace the local row's id.
          this.replaceLocalId(local, created.id);
          pushed++;
        } else {
          // Existing record — PATCH the changed fields.
          await this.api.patchServerWorkflow(accessJwt, local.id, {
            name: local.name,
            description: local.description ?? "",
            graph: local.graph,
            schedule_cron: local.scheduleCron,
          });
          this.store.markSynced(local.id);
          pushed++;
        }
      } catch (err) {
        errors.push({ id: local.id, phase: "push", message: (err as Error).message });
      }
    }

    return { pulled, pushed, errors, durationMs: Date.now() - start };
  }

  /**
   * When a local-origin workflow is first pushed, the server assigns a
   * permanent UUID. We update the local row to use that id (delete + reinsert)
   * so subsequent syncs and references line up.
   */
  private replaceLocalId(local: LocalWorkflow, serverId: string): void {
    if (local.id === serverId) {
      this.store.markSynced(local.id);
      return;
    }
    this.store.delete(local.id);
    this.store.upsert({
      ...local,
      id: serverId,
      origin: "server",
      serverSyncedAt: Date.now(),
    });
  }
}
