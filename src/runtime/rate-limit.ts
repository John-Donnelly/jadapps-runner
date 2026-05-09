/**
 * Rolling-window rate limiter for the runner. Keyed on (user, action),
 * limits how many times an action can fire within a sliding window.
 *
 * Phase 5i / Phase 11 use case: cap `workflow_run` to 10/hr per token by
 * default. An AI agent calling workflow_run in a loop can't stampede the
 * orchestrator — the limiter rejects the 11th call within the window with
 * a structured violation the caller turns into a 429.
 *
 * Implementation: per-key Deque of timestamps (Number[]). On each call we
 * drop entries older than the window, check the remaining count, and
 * either accept (push the new timestamp) or reject. O(n) per call where n
 * is the in-window count, which for 10/hr defaults stays trivial.
 *
 * Tier-driven overrides plug in via the `limit` arg — the caller resolves
 * the right number from access claims before calling. Pass 0 (or a
 * negative number) to disable the cap for unlimited tiers (enterprise).
 */

interface BucketEntry {
  /** Timestamp (ms) of the call. */
  ts: number;
}

export interface RateLimitResult {
  ok: boolean;
  /** Number of calls remaining in the current window. */
  remaining: number;
  /** When the oldest in-window call drops out — empty when not throttled. */
  retryAfterMs: number;
}

export class RateLimiter {
  private buckets = new Map<string, BucketEntry[]>();

  /**
   * Check + record a call. `windowMs` and `limit` come from the caller so
   * the same limiter can serve different policies (e.g. 10/hr for
   * workflow_run vs 100/hr for tool_run).
   */
  check(key: string, limit: number, windowMs: number): RateLimitResult {
    if (limit <= 0) {
      return { ok: true, remaining: Number.MAX_SAFE_INTEGER, retryAfterMs: 0 };
    }
    const now = Date.now();
    const cutoff = now - windowMs;
    const bucket = this.buckets.get(key) ?? [];
    // Drop expired entries — tail-only cleanup so the array stays sorted.
    while (bucket.length > 0 && bucket[0]!.ts < cutoff) {
      bucket.shift();
    }
    if (bucket.length >= limit) {
      const oldest = bucket[0]!.ts;
      const retryAfterMs = Math.max(0, oldest + windowMs - now);
      this.buckets.set(key, bucket);
      return { ok: false, remaining: 0, retryAfterMs };
    }
    bucket.push({ ts: now });
    this.buckets.set(key, bucket);
    return {
      ok: true,
      remaining: Math.max(0, limit - bucket.length),
      retryAfterMs: 0,
    };
  }

  /** Test helper — clears all buckets. */
  reset(): void {
    this.buckets.clear();
  }
}

/**
 * Default policy for workflow_run. Plan §5i mandates 10/hr per token;
 * developer/enterprise tiers may override via streaming claims, but for
 * Phase 11 a single global default is enough — the higher tiers also
 * have higher concurrency caps so they're already shaped by Phase 9b.
 */
export const WORKFLOW_RUN_LIMIT = 10;
export const WORKFLOW_RUN_WINDOW_MS = 60 * 60 * 1000; // 1 hour
