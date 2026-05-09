import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RateLimiter } from "../src/runtime/rate-limit";

describe("RateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-09T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("permits up to limit then rejects", () => {
    const r = new RateLimiter();
    for (let i = 0; i < 10; i++) {
      expect(r.check("alice", 10, 60_000).ok).toBe(true);
    }
    const eleventh = r.check("alice", 10, 60_000);
    expect(eleventh.ok).toBe(false);
    expect(eleventh.remaining).toBe(0);
    // First call was at t=0, window is 60s; retry-after should be ~60s.
    expect(eleventh.retryAfterMs).toBeGreaterThan(59_000);
    expect(eleventh.retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  it("releases slots after the window passes", () => {
    const r = new RateLimiter();
    r.check("alice", 2, 60_000);
    r.check("alice", 2, 60_000);
    expect(r.check("alice", 2, 60_000).ok).toBe(false);
    vi.advanceTimersByTime(61_000);
    expect(r.check("alice", 2, 60_000).ok).toBe(true);
  });

  it("treats limit<=0 as unlimited", () => {
    const r = new RateLimiter();
    for (let i = 0; i < 1000; i++) {
      expect(r.check("alice", 0, 60_000).ok).toBe(true);
    }
  });

  it("is keyed per user", () => {
    const r = new RateLimiter();
    r.check("alice", 1, 60_000);
    expect(r.check("alice", 1, 60_000).ok).toBe(false);
    expect(r.check("bob", 1, 60_000).ok).toBe(true);
  });

  it("reset() clears all state", () => {
    const r = new RateLimiter();
    r.check("alice", 1, 60_000);
    expect(r.check("alice", 1, 60_000).ok).toBe(false);
    r.reset();
    expect(r.check("alice", 1, 60_000).ok).toBe(true);
  });

  it("tracks remaining count accurately", () => {
    const r = new RateLimiter();
    expect(r.check("alice", 5, 60_000).remaining).toBe(4);
    expect(r.check("alice", 5, 60_000).remaining).toBe(3);
    expect(r.check("alice", 5, 60_000).remaining).toBe(2);
  });
});
