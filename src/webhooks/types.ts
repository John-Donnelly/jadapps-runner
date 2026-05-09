// Types for the runner-managed webhook surface. Matches the shape used by
// the dashboard's `lib/runner-client/types.ts` so the website can consume
// /v1/webhooks responses directly.

export type WebhookEvent = "workflow.completed" | "workflow.failed" | "test";

/** Public-facing webhook record. The secret is never returned. */
export interface WebhookConfig {
  id: string;
  name: string;
  url: string;
  events: WebhookEvent[];
  active: boolean;
  failureCount: number;
  lastTriggeredAt: string | null;
  lastStatusCode: number | null;
  lastError: string | null;
  createdAt: string;
}

// Optional fields explicitly allow `undefined` so they round-trip cleanly
// through zod's `.optional()` under `exactOptionalPropertyTypes: true`.

export interface WebhookCreateInput {
  name: string;
  url: string;
  events: WebhookEvent[];
  active?: boolean | undefined;
}

export interface WebhookUpdateInput {
  name?: string | undefined;
  url?: string | undefined;
  events?: WebhookEvent[] | undefined;
  active?: boolean | undefined;
}

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  eventType: WebhookEvent;
  responseStatus: number | null;
  durationMs: number | null;
  error: string | null;
  deliveredAt: string;
}

/**
 * Payload posted to subscriber URLs. Intentionally small — we never include
 * step outputs, file contents, or credential refs. Recipients who need the
 * full run details should poll the runner's run-history surface instead.
 */
export interface WebhookPayload {
  event: WebhookEvent;
  delivered_at: string;
  workflow: {
    id: string;
    name: string;
    version: number | null;
  };
  run: {
    id: string;
    status: "succeeded" | "failed";
    started_at: string;
    finished_at: string;
    duration_ms: number;
    bytes_processed: number;
    step_count: number;
    error: string | null;
  };
}
