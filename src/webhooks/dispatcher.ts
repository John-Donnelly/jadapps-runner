import { createHmac } from "node:crypto";
import { request as undiciRequest } from "undici";
import type { Logger } from "../log.js";
import type { WebhookStore, WebhookWithSecret } from "./store.js";
import type { WebhookEvent, WebhookPayload } from "./types.js";

const DELIVERY_TIMEOUT_MS = 10_000;
const RETRY_DELAYS_MS = [1_000, 5_000, 30_000];
const RUNNER_USER_AGENT = "jadapps-runner/0.1.0";

interface DispatchOutcome {
  ok: boolean;
  status: number | null;
  durationMs: number;
  error: string | null;
}

/**
 * Outbound delivery for runner-managed webhooks. Fires asynchronously when
 * a workflow finishes — never blocks the run. Each subscriber gets up to
 * three attempts with exponential backoff; persistent failures roll up
 * into the webhook's `failure_count` and trigger auto-disable after 10
 * consecutive misses.
 */
export class WebhookDispatcher {
  private inFlight: Set<Promise<unknown>> = new Set();

  constructor(
    private readonly store: WebhookStore,
    private readonly log: Logger,
  ) {}

  /**
   * Dispatch `payload` to every active webhook subscribed to `event`.
   * Fire-and-forget — caller does NOT await delivery. Use `flush()` at
   * shutdown to drain outstanding deliveries.
   */
  fireForEvent(event: WebhookEvent, payload: WebhookPayload): void {
    const subscribers = this.store.findActiveForEvent(event);
    if (subscribers.length === 0) return;
    for (const wh of subscribers) {
      this.scheduleDelivery(wh, event, payload);
    }
  }

  /**
   * One-off delivery used by the test endpoint. Returns the final outcome
   * synchronously (single attempt, no retries) so the UI can show "delivered"
   * or "HTTP 500" immediately.
   */
  async testFire(webhookId: string): Promise<DispatchOutcome> {
    const wh = this.store.getWithSecret(webhookId);
    if (!wh) {
      return { ok: false, status: null, durationMs: 0, error: "webhook not found" };
    }
    const payload = {
      event: "test" as const,
      delivered_at: new Date().toISOString(),
      test: true,
      runner: "@jadapps/runner",
    };
    const outcome = await deliverOnce(wh, "test", payload);
    this.store.recordDelivery(webhookId, {
      eventType: "test",
      responseStatus: outcome.status,
      durationMs: outcome.durationMs,
      error: outcome.error,
    });
    return outcome;
  }

  async flush(timeoutMs = 5_000): Promise<void> {
    if (this.inFlight.size === 0) return;
    const all = Promise.allSettled([...this.inFlight]);
    await Promise.race([
      all,
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  private scheduleDelivery(
    wh: WebhookWithSecret,
    event: WebhookEvent,
    payload: WebhookPayload,
  ): void {
    const work = (async () => {
      let outcome: DispatchOutcome = {
        ok: false,
        status: null,
        durationMs: 0,
        error: "no attempt",
      };
      for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
        outcome = await deliverOnce(wh, event, payload);
        if (outcome.ok) break;
        const next = RETRY_DELAYS_MS[attempt];
        if (next === undefined) break;
        await sleep(next);
      }
      this.store.recordDelivery(wh.id, {
        eventType: event,
        responseStatus: outcome.status,
        durationMs: outcome.durationMs,
        error: outcome.error,
      });
      if (!outcome.ok) {
        this.log.warn(
          { webhookId: wh.id, event, status: outcome.status, error: outcome.error },
          "webhook delivery failed after retries",
        );
      }
    })().catch((err) => {
      this.log.error({ err, webhookId: wh.id, event }, "webhook dispatcher crashed");
    });

    this.inFlight.add(work);
    void work.finally(() => this.inFlight.delete(work));
  }
}

async function deliverOnce(
  wh: WebhookWithSecret,
  event: WebhookEvent,
  payload: unknown,
): Promise<DispatchOutcome> {
  const body = JSON.stringify(payload);
  const signature = createHmac("sha256", wh.secret).update(body).digest("hex");
  const start = Date.now();

  try {
    const res = await undiciRequest(wh.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": RUNNER_USER_AGENT,
        "x-jad-event": event,
        "x-jad-signature": `sha256=${signature}`,
      },
      body,
      bodyTimeout: DELIVERY_TIMEOUT_MS,
      headersTimeout: DELIVERY_TIMEOUT_MS,
    });
    // Drain so undici can release the connection.
    await res.body.text().catch(() => undefined);
    const durationMs = Date.now() - start;
    const status = res.statusCode;
    if (status >= 200 && status < 300) {
      return { ok: true, status, durationMs, error: null };
    }
    return {
      ok: false,
      status,
      durationMs,
      error: `non-2xx response (HTTP ${status})`,
    };
  } catch (err) {
    return {
      ok: false,
      status: null,
      durationMs: Date.now() - start,
      error: truncate((err as Error).message ?? "unknown error", 500),
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}
