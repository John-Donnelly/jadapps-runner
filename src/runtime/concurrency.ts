/**
 * Per-user concurrency semaphore. Each pairing token (which authenticates
 * a single device, and through it a single user) gets a fixed number of
 * permits matching the tier's `streaming.batchMaxParallel` cap. tryAcquire
 * is non-blocking: callers decide whether to 429 or queue.
 *
 * The runner only has one paired user, so a single Map keyed by `sub`
 * (email) is plenty. If multi-user support ever lands, the same shape
 * still works — keys just diverge.
 */

interface Entry {
  permits: number;
  inFlight: number;
}

export class ConcurrencyLimiter {
  private entries = new Map<string, Entry>();

  /**
   * Try to acquire a permit for `key`. Returns true if successful (caller
   * MUST release). Returns false when the cap is exceeded — caller should
   * 429 the upstream request.
   *
   * `permits` configures the cap for the key on first call; subsequent
   * calls reuse the same cap (no resize). Pass 0 or a negative value to
   * disable the cap (unlimited concurrency for that key).
   */
  tryAcquire(key: string, permits: number): boolean {
    if (permits <= 0) return true;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { permits, inFlight: 0 };
      this.entries.set(key, entry);
    }
    if (entry.inFlight >= entry.permits) return false;
    entry.inFlight++;
    return true;
  }

  release(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.inFlight > 0) entry.inFlight--;
  }

  inFlight(key: string): number {
    return this.entries.get(key)?.inFlight ?? 0;
  }

  /**
   * Replace the per-key permits cap. Used when the access token's
   * streaming.batchMaxParallel changes between refreshes (e.g. user
   * upgrades tier). Existing inFlight count is preserved.
   */
  setPermits(key: string, permits: number): void {
    const entry = this.entries.get(key);
    if (!entry) {
      this.entries.set(key, { permits, inFlight: 0 });
    } else {
      entry.permits = permits;
    }
  }
}
