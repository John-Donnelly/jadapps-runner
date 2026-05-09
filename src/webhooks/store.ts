import type Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { decryptJson, encryptJson } from "../credentials/crypto.js";
import type {
  WebhookConfig,
  WebhookCreateInput,
  WebhookDelivery,
  WebhookEvent,
  WebhookUpdateInput,
} from "./types.js";

/**
 * Local webhook storage on the runner. Webhook URLs, secrets, and delivery
 * history live entirely in this SQLite database — JAD's servers never see
 * any of it. Secrets are AES-GCM encrypted with the same master key used
 * for the credential vault.
 *
 * Schema lives in the same SQLite file as credentials/workflows; the
 * WebhookStore consumes a Database instance opened by CredentialStore.
 */

const AUTO_DISABLE_AFTER = 10;
const DELIVERY_HISTORY_LIMIT = 50;
const MAX_DELIVERIES_RETAINED = 200;

interface RawWebhookRow {
  id: string;
  name: string;
  url: string;
  events: string;
  secret_ciphertext: string;
  active: number;
  failure_count: number;
  last_triggered_at: number | null;
  last_status_code: number | null;
  last_error: string | null;
  created_at: number;
}

interface RawDeliveryRow {
  id: string;
  webhook_id: string;
  event_type: WebhookEvent;
  response_status: number | null;
  duration_ms: number | null;
  error: string | null;
  delivered_at: number;
}

/** Internal shape used by the dispatcher — includes the decrypted secret. */
export interface WebhookWithSecret extends WebhookConfig {
  secret: string;
}

export class WebhookStore {
  constructor(
    private readonly db: Database.Database,
    private readonly masterKey: string,
  ) {}

  init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS webhooks (
        id                TEXT PRIMARY KEY,
        name              TEXT NOT NULL,
        url               TEXT NOT NULL,
        events            TEXT NOT NULL,
        secret_ciphertext TEXT NOT NULL,
        active            INTEGER NOT NULL DEFAULT 1,
        failure_count     INTEGER NOT NULL DEFAULT 0,
        last_triggered_at INTEGER,
        last_status_code  INTEGER,
        last_error        TEXT,
        created_at        INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id              TEXT PRIMARY KEY,
        webhook_id      TEXT NOT NULL,
        event_type      TEXT NOT NULL,
        response_status INTEGER,
        duration_ms     INTEGER,
        error           TEXT,
        delivered_at    INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS webhook_deliveries_lookup_idx
        ON webhook_deliveries (webhook_id, delivered_at DESC);
    `);
  }

  list(): WebhookConfig[] {
    const rows = this.db
      .prepare(
        `SELECT id, name, url, events, secret_ciphertext, active, failure_count,
                last_triggered_at, last_status_code, last_error, created_at
         FROM webhooks
         ORDER BY created_at DESC`,
      )
      .all() as RawWebhookRow[];
    return rows.map(rowToConfig);
  }

  get(id: string): WebhookConfig | null {
    const row = this.findRow(id);
    return row ? rowToConfig(row) : null;
  }

  /** Internal-only: returns the decrypted secret alongside the config. */
  getWithSecret(id: string): WebhookWithSecret | null {
    const row = this.findRow(id);
    if (!row) return null;
    return { ...rowToConfig(row), secret: this.decryptSecret(row.secret_ciphertext) };
  }

  /**
   * Active webhooks subscribed to `event`, with their secret available so
   * the dispatcher can sign requests. Used at delivery time only.
   */
  findActiveForEvent(event: WebhookEvent): WebhookWithSecret[] {
    const rows = this.db
      .prepare(
        `SELECT id, name, url, events, secret_ciphertext, active, failure_count,
                last_triggered_at, last_status_code, last_error, created_at
         FROM webhooks
         WHERE active = 1`,
      )
      .all() as RawWebhookRow[];
    const out: WebhookWithSecret[] = [];
    for (const row of rows) {
      const cfg = rowToConfig(row);
      if (!cfg.events.includes(event)) continue;
      out.push({ ...cfg, secret: this.decryptSecret(row.secret_ciphertext) });
    }
    return out;
  }

  create(input: WebhookCreateInput): WebhookConfig {
    const id = randomUUID();
    const secret = randomBytes(32).toString("hex");
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO webhooks
           (id, name, url, events, secret_ciphertext, active, failure_count,
            last_triggered_at, last_status_code, last_error, created_at)
         VALUES
           (@id, @name, @url, @events, @secret_ciphertext, @active, 0,
            NULL, NULL, NULL, @created_at)`,
      )
      .run({
        id,
        name: input.name,
        url: input.url,
        events: JSON.stringify(input.events),
        secret_ciphertext: this.encryptSecret(secret),
        active: input.active === false ? 0 : 1,
        created_at: now,
      });
    return this.get(id)!;
  }

  update(id: string, input: WebhookUpdateInput): WebhookConfig | null {
    const existing = this.findRow(id);
    if (!existing) return null;

    const fields: string[] = [];
    const params: Record<string, unknown> = { id };

    if (input.name !== undefined) {
      fields.push("name = @name");
      params.name = input.name;
    }
    if (input.url !== undefined) {
      fields.push("url = @url");
      params.url = input.url;
    }
    if (input.events !== undefined) {
      fields.push("events = @events");
      params.events = JSON.stringify(input.events);
    }
    if (input.active !== undefined) {
      fields.push("active = @active");
      params.active = input.active ? 1 : 0;
      // Re-enabling clears the failure counter so the dispatcher gives it a
      // fresh shot before auto-disabling again.
      if (input.active && existing.failure_count > 0) {
        fields.push("failure_count = 0", "last_error = NULL");
      }
    }

    if (fields.length === 0) return rowToConfig(existing);

    this.db
      .prepare(`UPDATE webhooks SET ${fields.join(", ")} WHERE id = @id`)
      .run(params);
    return this.get(id);
  }

  delete(id: string): boolean {
    const tx = this.db.transaction((deleteId: string) => {
      this.db.prepare(`DELETE FROM webhook_deliveries WHERE webhook_id = ?`).run(deleteId);
      return this.db.prepare(`DELETE FROM webhooks WHERE id = ?`).run(deleteId).changes;
    });
    return tx(id) > 0;
  }

  /**
   * Record the outcome of a delivery attempt. Updates the webhook's
   * `last_*` summary fields and, on failure, increments `failure_count` and
   * auto-disables after `AUTO_DISABLE_AFTER` consecutive misses. On success
   * the counter resets.
   *
   * Test-event deliveries (eventType="test") update `last_*` for visibility
   * but do NOT mutate `failure_count` or auto-disable — they're a probe.
   */
  recordDelivery(
    webhookId: string,
    outcome: {
      eventType: WebhookEvent;
      responseStatus: number | null;
      durationMs: number | null;
      error: string | null;
    },
  ): void {
    const now = Date.now();
    const ok = outcome.responseStatus !== null && outcome.responseStatus < 300;
    const isTest = outcome.eventType === "test";

    const tx = this.db.transaction(() => {
      const stmt = this.db.prepare(
        `INSERT INTO webhook_deliveries
           (id, webhook_id, event_type, response_status, duration_ms, error, delivered_at)
         VALUES (@id, @webhook_id, @event_type, @response_status, @duration_ms, @error, @delivered_at)`,
      );
      stmt.run({
        id: randomUUID(),
        webhook_id: webhookId,
        event_type: outcome.eventType,
        response_status: outcome.responseStatus,
        duration_ms: outcome.durationMs,
        error: outcome.error,
        delivered_at: now,
      });

      if (isTest) {
        this.db
          .prepare(
            `UPDATE webhooks SET
               last_triggered_at = @now,
               last_status_code  = @status,
               last_error        = @error
             WHERE id = @id`,
          )
          .run({
            id: webhookId,
            now,
            status: outcome.responseStatus,
            error: outcome.error,
          });
      } else if (ok) {
        this.db
          .prepare(
            `UPDATE webhooks SET
               last_triggered_at = @now,
               last_status_code  = @status,
               last_error        = NULL,
               failure_count     = 0
             WHERE id = @id`,
          )
          .run({ id: webhookId, now, status: outcome.responseStatus });
      } else {
        const row = this.findRow(webhookId);
        if (!row) return;
        const newCount = row.failure_count + 1;
        const shouldDisable = newCount >= AUTO_DISABLE_AFTER;
        this.db
          .prepare(
            `UPDATE webhooks SET
               last_triggered_at = @now,
               last_status_code  = @status,
               last_error        = @error,
               failure_count     = @count,
               active            = CASE WHEN @disable = 1 THEN 0 ELSE active END
             WHERE id = @id`,
          )
          .run({
            id: webhookId,
            now,
            status: outcome.responseStatus,
            error: outcome.error,
            count: newCount,
            disable: shouldDisable ? 1 : 0,
          });
      }

      // Trim retained delivery history per webhook so the table can't grow
      // unboundedly. Keep newest MAX_DELIVERIES_RETAINED rows.
      this.db
        .prepare(
          `DELETE FROM webhook_deliveries
           WHERE webhook_id = @id
             AND id NOT IN (
               SELECT id FROM webhook_deliveries
               WHERE webhook_id = @id
               ORDER BY delivered_at DESC
               LIMIT @keep
             )`,
        )
        .run({ id: webhookId, keep: MAX_DELIVERIES_RETAINED });
    });
    tx();
  }

  listDeliveries(webhookId: string): WebhookDelivery[] {
    const rows = this.db
      .prepare(
        `SELECT id, webhook_id, event_type, response_status, duration_ms, error, delivered_at
         FROM webhook_deliveries
         WHERE webhook_id = ?
         ORDER BY delivered_at DESC
         LIMIT ?`,
      )
      .all(webhookId, DELIVERY_HISTORY_LIMIT) as RawDeliveryRow[];
    return rows.map(rowToDelivery);
  }

  private findRow(id: string): RawWebhookRow | null {
    const row = this.db
      .prepare(
        `SELECT id, name, url, events, secret_ciphertext, active, failure_count,
                last_triggered_at, last_status_code, last_error, created_at
         FROM webhooks
         WHERE id = ?`,
      )
      .get(id) as RawWebhookRow | undefined;
    return row ?? null;
  }

  private encryptSecret(secret: string): string {
    return encryptJson(this.masterKey, { secret });
  }

  private decryptSecret(ciphertext: string): string {
    const obj = decryptJson<{ secret: string }>(this.masterKey, ciphertext);
    return obj.secret;
  }
}

function rowToConfig(row: RawWebhookRow): WebhookConfig {
  let events: WebhookEvent[] = [];
  try {
    const parsed = JSON.parse(row.events) as unknown;
    if (Array.isArray(parsed)) events = parsed.filter((e): e is WebhookEvent => typeof e === "string");
  } catch {
    /* leave empty */
  }
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    events,
    active: row.active === 1,
    failureCount: row.failure_count,
    lastTriggeredAt: row.last_triggered_at ? new Date(row.last_triggered_at).toISOString() : null,
    lastStatusCode: row.last_status_code,
    lastError: row.last_error,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function rowToDelivery(row: RawDeliveryRow): WebhookDelivery {
  return {
    id: row.id,
    webhookId: row.webhook_id,
    eventType: row.event_type,
    responseStatus: row.response_status,
    durationMs: row.duration_ms,
    error: row.error,
    deliveredAt: new Date(row.delivered_at).toISOString(),
  };
}
