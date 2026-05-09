import type Database from "better-sqlite3";
import type { TelemetryEvent } from "../types.js";

export class EventQueue {
  constructor(private readonly db: Database.Database) {}

  enqueue(event: TelemetryEvent): void {
    this.db
      .prepare(`INSERT INTO event_queue (run_id, payload, ts) VALUES (?, ?, ?)`)
      .run(event.runId, JSON.stringify(event), event.ts);
  }

  drain(limit = 50): Array<{ seq: number; event: TelemetryEvent }> {
    const rows = this.db
      .prepare(`SELECT seq, payload FROM event_queue ORDER BY seq ASC LIMIT ?`)
      .all(limit) as Array<{ seq: number; payload: string }>;
    return rows.map((r) => ({ seq: r.seq, event: JSON.parse(r.payload) as TelemetryEvent }));
  }

  ack(seqs: number[]): void {
    if (seqs.length === 0) return;
    const placeholders = seqs.map(() => "?").join(",");
    this.db.prepare(`DELETE FROM event_queue WHERE seq IN (${placeholders})`).run(...seqs);
  }

  size(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM event_queue`).get() as { n: number };
    return row.n;
  }

  /**
   * Read the most recent N events from the queue without dequeuing. Used by
   * the runner_logs_tail MCP tool so AI agents can debug in-flight runs
   * without affecting the flush cycle.
   */
  recent(limit = 50): Array<{ seq: number; event: TelemetryEvent }> {
    const rows = this.db
      .prepare(
        `SELECT seq, payload FROM event_queue ORDER BY seq DESC LIMIT ?`,
      )
      .all(limit) as Array<{ seq: number; payload: string }>;
    return rows.map((r) => ({ seq: r.seq, event: JSON.parse(r.payload) as TelemetryEvent }));
  }
}
