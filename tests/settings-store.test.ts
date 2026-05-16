import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SettingsStore, defaultSettings, validatePatch } from "../src/settings/store";

describe("SettingsStore", () => {
  let tmp: string;
  let db: Database.Database;
  let store: SettingsStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "jadapps-settings-"));
    db = new Database(join(tmp, "test.db"));
    store = new SettingsStore(db);
    store.init();
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns defaults when nothing is stored", () => {
    const s = store.get();
    expect(s.outputDir).toBe(join(homedir(), "jadapps-outputs"));
    expect(s.perToolSubfolders).toBe(false);
    expect(s.schemaVersion).toBe(1);
  });

  it("persists outputDir and reads it back across instances", () => {
    const newDir = join(tmp, "my-outputs");
    store.apply({ outputDir: newDir });
    expect(store.get().outputDir).toBe(newDir);

    // New instance against the same db sees the same value
    const fresh = new SettingsStore(db);
    expect(fresh.get().outputDir).toBe(newDir);
  });

  it("toggles perToolSubfolders independently", () => {
    store.apply({ perToolSubfolders: true });
    expect(store.get().perToolSubfolders).toBe(true);
    expect(store.get().outputDir).toBe(join(homedir(), "jadapps-outputs"));

    store.apply({ perToolSubfolders: false });
    expect(store.get().perToolSubfolders).toBe(false);
  });

  it("resolveOutputDir uses <root>/<runId> by default", () => {
    const root = join(tmp, "out");
    store.apply({ outputDir: root });
    expect(store.resolveOutputDir("run-1")).toBe(join(root, "run-1"));
    expect(store.resolveOutputDir("run-2", "stl-converter")).toBe(join(root, "run-2"));
  });

  it("resolveOutputDir uses <root>/<slug>/<runId> when perToolSubfolders is on", () => {
    const root = join(tmp, "out2");
    store.apply({ outputDir: root, perToolSubfolders: true });
    expect(store.resolveOutputDir("run-1", "stl-converter")).toBe(
      join(root, "stl-converter", "run-1"),
    );
  });

  it("resolveOutputDir sanitises unsafe slug characters", () => {
    const root = join(tmp, "out3");
    store.apply({ outputDir: root, perToolSubfolders: true });
    const path = store.resolveOutputDir("run-1", "../../etc/passwd");
    // No traversal — `/`, `.` doubled, `\` all replaced with `_`
    expect(path).toBe(join(root, ".._.._etc_passwd", "run-1"));
  });

  it("falls back to runId-only when toolSlug is empty even with perToolSubfolders=true", () => {
    const root = join(tmp, "out4");
    store.apply({ outputDir: root, perToolSubfolders: true });
    expect(store.resolveOutputDir("run-1")).toBe(join(root, "run-1"));
    expect(store.resolveOutputDir("run-1", "")).toBe(join(root, "run-1"));
    expect(store.resolveOutputDir("run-1", "   ")).toBe(join(root, "run-1"));
  });
});

describe("validatePatch", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "jadapps-validate-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("accepts a writable absolute outputDir", () => {
    const result = validatePatch({ outputDir: tmp });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.outputDir).toBe(tmp);
  });

  it("creates the directory when it does not exist", () => {
    const newDir = join(tmp, "nested", "child");
    expect(existsSync(newDir)).toBe(false);
    const result = validatePatch({ outputDir: newDir });
    expect(result.ok).toBe(true);
    expect(existsSync(newDir)).toBe(true);
  });

  it("rejects empty / non-string outputDir", () => {
    const r1 = validatePatch({ outputDir: "" });
    expect(r1.ok).toBe(false);
    const r2 = validatePatch({ outputDir: 123 as unknown as string });
    expect(r2.ok).toBe(false);
  });

  it("rejects a path that points at an existing file", () => {
    const filePath = join(tmp, "iam-a-file.txt");
    writeFileSync(filePath, "hi", "utf8");
    const result = validatePatch({ outputDir: filePath });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]!.field).toBe("outputDir");
      expect(result.errors[0]!.message).toMatch(/not a directory/);
    }
  });

  it("rejects non-boolean perToolSubfolders", () => {
    const result = validatePatch({
      perToolSubfolders: "yes" as unknown as boolean,
    });
    expect(result.ok).toBe(false);
  });

  it("accepts a partial patch", () => {
    const result = validatePatch({ perToolSubfolders: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.perToolSubfolders).toBe(true);
      expect(result.value.outputDir).toBeUndefined();
    }
  });
});

describe("defaultSettings", () => {
  it("uses ~/jadapps-outputs as the default output directory", () => {
    expect(defaultSettings().outputDir).toBe(join(homedir(), "jadapps-outputs"));
  });
});
