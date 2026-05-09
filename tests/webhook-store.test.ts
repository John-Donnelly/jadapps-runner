import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { WebhookStore } from "../src/webhooks/store";
import { generateMasterKey } from "../src/credentials/crypto";

function newStore(): WebhookStore {
  const db = new Database(":memory:");
  const store = new WebhookStore(db, generateMasterKey());
  store.init();
  return store;
}

describe("WebhookStore", () => {
  let store: WebhookStore;

  beforeEach(() => {
    store = newStore();
  });

  it("creates and lists webhooks without exposing secrets", () => {
    const created = store.create({
      name: "Slack",
      url: "https://hooks.slack.com/test",
      events: ["workflow.completed"],
    });
    expect(created.id).toBeTruthy();
    expect(created.failureCount).toBe(0);
    expect(created.active).toBe(true);
    expect((created as unknown as Record<string, unknown>).secret).toBeUndefined();

    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(created.id);
    expect((list[0] as unknown as Record<string, unknown>).secret).toBeUndefined();
  });

  it("returns the decrypted secret only via getWithSecret", () => {
    const created = store.create({
      name: "x",
      url: "https://example.test/x",
      events: ["workflow.completed"],
    });
    const withSecret = store.getWithSecret(created.id);
    expect(withSecret).not.toBeNull();
    expect(withSecret!.secret).toMatch(/^[0-9a-f]{64}$/);
  });

  it("findActiveForEvent matches subscribed webhooks only", () => {
    const a = store.create({
      name: "completed-only",
      url: "https://a.test",
      events: ["workflow.completed"],
    });
    store.create({
      name: "failed-only",
      url: "https://b.test",
      events: ["workflow.failed"],
    });
    const inactive = store.create({
      name: "disabled",
      url: "https://c.test",
      events: ["workflow.completed"],
    });
    store.update(inactive.id, { active: false });

    const matches = store.findActiveForEvent("workflow.completed");
    expect(matches.map((m) => m.id)).toEqual([a.id]);
  });

  it("update merges fields and clears failure_count when re-enabling", () => {
    const wh = store.create({
      name: "x",
      url: "https://example.test/x",
      events: ["workflow.completed"],
    });
    // Drive failure_count up via recordDelivery to simulate misses.
    for (let i = 0; i < 3; i++) {
      store.recordDelivery(wh.id, {
        eventType: "workflow.completed",
        responseStatus: 500,
        durationMs: 10,
        error: "boom",
      });
    }
    expect(store.get(wh.id)!.failureCount).toBe(3);

    // Disable, then re-enable — failure count should reset.
    store.update(wh.id, { active: false });
    const reEnabled = store.update(wh.id, { active: true });
    expect(reEnabled!.failureCount).toBe(0);
    expect(reEnabled!.lastError).toBeNull();
  });

  it("auto-disables after 10 consecutive failures", () => {
    const wh = store.create({
      name: "flaky",
      url: "https://flaky.test",
      events: ["workflow.completed"],
    });
    for (let i = 0; i < 9; i++) {
      store.recordDelivery(wh.id, {
        eventType: "workflow.completed",
        responseStatus: 500,
        durationMs: 5,
        error: "boom",
      });
    }
    expect(store.get(wh.id)!.active).toBe(true);
    store.recordDelivery(wh.id, {
      eventType: "workflow.completed",
      responseStatus: 500,
      durationMs: 5,
      error: "boom",
    });
    const after = store.get(wh.id)!;
    expect(after.active).toBe(false);
    expect(after.failureCount).toBe(10);
  });

  it("a 2xx delivery resets failure_count and clears last_error", () => {
    const wh = store.create({
      name: "x",
      url: "https://example.test/x",
      events: ["workflow.completed"],
    });
    store.recordDelivery(wh.id, {
      eventType: "workflow.completed",
      responseStatus: 502,
      durationMs: 5,
      error: "bad gateway",
    });
    store.recordDelivery(wh.id, {
      eventType: "workflow.completed",
      responseStatus: 200,
      durationMs: 8,
      error: null,
    });
    const after = store.get(wh.id)!;
    expect(after.failureCount).toBe(0);
    expect(after.lastError).toBeNull();
    expect(after.lastStatusCode).toBe(200);
  });

  it("test-event deliveries do not mutate failure_count", () => {
    const wh = store.create({
      name: "x",
      url: "https://example.test/x",
      events: ["workflow.completed"],
    });
    store.recordDelivery(wh.id, {
      eventType: "test",
      responseStatus: 500,
      durationMs: 5,
      error: "boom",
    });
    expect(store.get(wh.id)!.failureCount).toBe(0);
    expect(store.get(wh.id)!.active).toBe(true);
  });

  it("delete removes the webhook and cascades its delivery history", () => {
    const wh = store.create({
      name: "x",
      url: "https://example.test/x",
      events: ["workflow.completed"],
    });
    store.recordDelivery(wh.id, {
      eventType: "workflow.completed",
      responseStatus: 200,
      durationMs: 1,
      error: null,
    });
    expect(store.listDeliveries(wh.id)).toHaveLength(1);
    expect(store.delete(wh.id)).toBe(true);
    expect(store.get(wh.id)).toBeNull();
    expect(store.listDeliveries(wh.id)).toHaveLength(0);
  });
});
