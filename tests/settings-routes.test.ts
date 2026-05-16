import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import Database from "better-sqlite3";
import { SettingsStore } from "../src/settings/store";

/**
 * Targeted integration test for the /v1/settings GET + PATCH routes.
 * We don't boot the whole runner — we re-use just the pieces of
 * registerRoutes() that touch the settings store, hand-wired here for
 * isolation. The contract under test is the request/response shape; the
 * heavy lifting is in SettingsStore + validatePatch (covered elsewhere).
 */

// Replicate the route handler logic from src/server/routes.ts in
// isolation so this test stays decoupled from the full Deps graph.
async function buildApp(store: SettingsStore): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const { z } = await import("zod");
  const { validatePatch } = await import("../src/settings/store");

  app.get("/v1/settings", async () => store.get());

  const SettingsPatchSchema = z
    .object({
      outputDir: z.string().min(1).optional(),
      perToolSubfolders: z.boolean().optional(),
    })
    .strict();

  app.patch("/v1/settings", async (req, reply) => {
    const parsed = SettingsPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid body", issues: parsed.error.issues });
      return;
    }
    const patch: Parameters<typeof validatePatch>[0] = {};
    if (parsed.data.outputDir !== undefined) patch.outputDir = parsed.data.outputDir;
    if (parsed.data.perToolSubfolders !== undefined) {
      patch.perToolSubfolders = parsed.data.perToolSubfolders;
    }
    const validation = validatePatch(patch);
    if (!validation.ok) {
      reply.code(400).send({ error: "invalid settings", issues: validation.errors });
      return;
    }
    return store.apply(validation.value);
  });

  await app.ready();
  return app;
}

describe("/v1/settings routes", () => {
  let tmp: string;
  let db: Database.Database;
  let store: SettingsStore;
  let app: FastifyInstance;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "jadapps-routes-"));
    db = new Database(join(tmp, "test.db"));
    store = new SettingsStore(db);
    store.init();
    app = await buildApp(store);
  });

  afterEach(async () => {
    await app.close();
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("GET returns the default settings before any patch", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/settings" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.outputDir).toMatch(/jadapps-outputs$/);
    expect(body.perToolSubfolders).toBe(false);
    expect(body.schemaVersion).toBe(1);
  });

  it("PATCH applies a valid outputDir change", async () => {
    const newDir = join(tmp, "out-target");
    const res = await app.inject({
      method: "PATCH",
      url: "/v1/settings",
      payload: { outputDir: newDir },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ outputDir: newDir });

    // GET reflects the change
    const followup = await app.inject({ method: "GET", url: "/v1/settings" });
    expect(followup.json()).toMatchObject({ outputDir: newDir });
  });

  it("PATCH applies perToolSubfolders toggle", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/v1/settings",
      payload: { perToolSubfolders: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ perToolSubfolders: true });
  });

  it("PATCH rejects an outputDir that points at a file", async () => {
    const filePath = join(tmp, "iam-a-file.txt");
    writeFileSync(filePath, "hi", "utf8");
    const res = await app.inject({
      method: "PATCH",
      url: "/v1/settings",
      payload: { outputDir: filePath },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string; issues: { field: string }[] };
    expect(body.error).toMatch(/invalid settings/);
    expect(body.issues[0]!.field).toBe("outputDir");
  });

  it("PATCH rejects unknown fields (strict schema)", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/v1/settings",
      payload: { unknownField: "x" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("PATCH with an empty body is a no-op that returns current settings", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/v1/settings",
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ schemaVersion: 1 });
  });

  it("PATCH rejects non-boolean perToolSubfolders", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/v1/settings",
      payload: { perToolSubfolders: "yes" },
    });
    expect(res.statusCode).toBe(400);
  });
});
