import type { ApiClient } from "../api/client.js";
import type { Logger } from "../log.js";
import type { TelemetryEvent } from "../types.js";
import type { EventQueue } from "./queue.js";

const FLUSH_INTERVAL_MS = 5_000;
const BATCH_SIZE = 50;

export class TelemetryClient {
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;
  /** Map runId → most-recent runToken so we can ship queued events after the run ends. */
  private runTokens = new Map<string, string>();

  constructor(
    private readonly queue: EventQueue,
    private readonly api: ApiClient,
    private readonly log: Logger,
  ) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Caller is responsible for assigning a strictly-increasing eventSeq per run. */
  emit(event: TelemetryEvent, runToken: string): void {
    this.runTokens.set(event.runId, runToken);
    this.queue.enqueue(event);
  }

  async flush(): Promise<{ revoked: string[] }> {
    if (this.flushing) return { revoked: [] };
    this.flushing = true;
    const revoked: string[] = [];
    try {
      while (true) {
        const batch = this.queue.drain(BATCH_SIZE);
        if (batch.length === 0) break;
        const byRun = new Map<string, Array<{ seq: number; event: TelemetryEvent }>>();
        for (const item of batch) {
          const list = byRun.get(item.event.runId) ?? [];
          list.push(item);
          byRun.set(item.event.runId, list);
        }
        for (const [runId, items] of byRun) {
          const token = this.runTokens.get(runId);
          if (!token) {
            // No token cached (process restart) — drop these events; server can
            // reconstruct from finalize call. Better: re-run preflight, but the
            // run is gone by definition.
            this.queue.ack(items.map((i) => i.seq));
            continue;
          }
          try {
            const res = await this.api.postEvents(
              runId,
              items.map((i) => i.event),
              token,
            );
            this.queue.ack(items.map((i) => i.seq));
            if (res.revoked) revoked.push(runId);
          } catch (err) {
            this.log.warn({ err, runId }, "telemetry flush failed; will retry");
            return { revoked };
          }
        }
      }
    } finally {
      this.flushing = false;
    }
    return { revoked };
  }
}
