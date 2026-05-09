import { describe, it, expect } from "vitest";
import { ConcurrencyLimiter } from "../src/runtime/concurrency";

describe("ConcurrencyLimiter", () => {
  it("allows acquires up to the cap, rejects past it", () => {
    const c = new ConcurrencyLimiter();
    expect(c.tryAcquire("alice", 2)).toBe(true);
    expect(c.tryAcquire("alice", 2)).toBe(true);
    expect(c.tryAcquire("alice", 2)).toBe(false);
    expect(c.inFlight("alice")).toBe(2);
  });

  it("releases free up slots", () => {
    const c = new ConcurrencyLimiter();
    c.tryAcquire("alice", 1);
    expect(c.tryAcquire("alice", 1)).toBe(false);
    c.release("alice");
    expect(c.tryAcquire("alice", 1)).toBe(true);
  });

  it("treats permits<=0 as unlimited", () => {
    const c = new ConcurrencyLimiter();
    for (let i = 0; i < 100; i++) {
      expect(c.tryAcquire("alice", 0)).toBe(true);
    }
    // No tracking entry was created, so inFlight is 0.
    expect(c.inFlight("alice")).toBe(0);
  });

  it("is keyed per user — bob's slots don't affect alice", () => {
    const c = new ConcurrencyLimiter();
    expect(c.tryAcquire("alice", 1)).toBe(true);
    expect(c.tryAcquire("bob", 1)).toBe(true);
    expect(c.tryAcquire("alice", 1)).toBe(false);
    expect(c.tryAcquire("bob", 1)).toBe(false);
  });

  it("release on an unknown key is a no-op", () => {
    const c = new ConcurrencyLimiter();
    expect(() => c.release("nobody")).not.toThrow();
    expect(c.inFlight("nobody")).toBe(0);
  });

  it("setPermits resizes the cap without dropping inFlight count", () => {
    const c = new ConcurrencyLimiter();
    c.tryAcquire("alice", 2);
    c.tryAcquire("alice", 2);
    c.setPermits("alice", 4);
    expect(c.tryAcquire("alice", 4)).toBe(true);
    expect(c.inFlight("alice")).toBe(3);
  });
});
