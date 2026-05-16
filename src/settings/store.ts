import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { statSync, mkdirSync, accessSync, constants } from "node:fs";
import type Database from "better-sqlite3";

/**
 * Phase B: user-tunable runner settings. Persisted in the same SQLite
 * file the credentials/workflows stores already use, under a simple
 * key-value table so we can add fields without migrations.
 *
 * The first setting is `outputDir` — where finished tool / workflow
 * outputs land. Defaults to `<home>/jadapps-outputs/` so behavior
 * matches the historical hard-coded value, but the user can change it
 * from the tray via `PATCH /v1/settings`.
 */

export interface RunnerSettings {
  /**
   * Absolute path to the directory under which per-run output folders
   * are created. The runner always writes to `<outputDir>/<runId>/`
   * (or `<outputDir>/<toolSlug>/<runId>/` when `perToolSubfolders` is
   * true).
   */
  outputDir: string;
  /**
   * When true, run outputs are organised into per-tool subfolders
   * (`<outputDir>/<toolSlug>/<runId>/`). Off by default — most users
   * find one folder per run easier to scan.
   */
  perToolSubfolders: boolean;
  /** Schema version for future migrations. */
  schemaVersion: number;
}

const SCHEMA_VERSION = 1;
const OUTPUTS_DIRNAME = "jadapps-outputs";

const SETTING_KEY_OUTPUT_DIR = "outputDir";
const SETTING_KEY_PER_TOOL = "perToolSubfolders";

/**
 * Default settings used when the database has no values yet. The
 * outputs folder is created lazily on first write so we don't litter
 * the user's home directory until a tool actually runs.
 */
export function defaultSettings(): RunnerSettings {
  return {
    outputDir: join(homedir(), OUTPUTS_DIRNAME),
    perToolSubfolders: false,
    schemaVersion: SCHEMA_VERSION,
  };
}

export type SettingsPatch = Partial<Pick<RunnerSettings, "outputDir" | "perToolSubfolders">>;

export interface SettingsValidationError {
  field: keyof RunnerSettings;
  message: string;
}

/**
 * Validates a patch BEFORE it's persisted. Returns the validated +
 * normalised values, or a list of validation errors. Path validation:
 *   - must be absolute (Windows: `C:\…`; POSIX: `/…`)
 *   - must exist OR be creatable
 *   - must be writable by the runner process
 */
export function validatePatch(
  patch: SettingsPatch,
): { ok: true; value: SettingsPatch } | { ok: false; errors: SettingsValidationError[] } {
  const errors: SettingsValidationError[] = [];
  const out: SettingsPatch = {};

  if (patch.outputDir !== undefined) {
    if (typeof patch.outputDir !== "string" || !patch.outputDir.trim()) {
      errors.push({ field: "outputDir", message: "outputDir must be a non-empty string" });
    } else {
      const normalised = resolve(patch.outputDir.trim());
      if (!isAbsolute(normalised)) {
        errors.push({
          field: "outputDir",
          message: `outputDir must be an absolute path (got ${patch.outputDir})`,
        });
      } else {
        const writableErr = ensureDirWritable(normalised);
        if (writableErr) {
          errors.push({ field: "outputDir", message: writableErr });
        } else {
          out.outputDir = normalised;
        }
      }
    }
  }

  if (patch.perToolSubfolders !== undefined) {
    if (typeof patch.perToolSubfolders !== "boolean") {
      errors.push({
        field: "perToolSubfolders",
        message: "perToolSubfolders must be a boolean",
      });
    } else {
      out.perToolSubfolders = patch.perToolSubfolders;
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: out };
}

/**
 * Ensures the given directory exists and is writable. Creates it (and
 * parent directories) when missing. Returns a non-null error string
 * when the path is unusable.
 */
function ensureDirWritable(path: string): string | null {
  try {
    let stats;
    try {
      stats = statSync(path);
    } catch {
      // Doesn't exist — try to create it
      mkdirSync(path, { recursive: true });
      return null;
    }
    if (!stats.isDirectory()) {
      return `path exists but is not a directory: ${path}`;
    }
    accessSync(path, constants.W_OK);
    return null;
  } catch (err) {
    return `path is not writable: ${path} (${(err as Error).message})`;
  }
}

/**
 * SQLite-backed key-value store for runner settings. Reuses the
 * existing `runner.db` so we don't add another file to the data dir.
 * Calls to `get()` are synchronous + cheap (one indexed lookup per
 * key); cache is unnecessary at this scale.
 */
export class SettingsStore {
  constructor(private readonly db: Database.Database) {}

  /**
   * Creates the settings table if missing. Idempotent — safe to call
   * on every runner boot.
   */
  init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  /** Returns the full settings object, falling back to defaults per-field. */
  get(): RunnerSettings {
    const defaults = defaultSettings();
    return {
      outputDir: this.readString(SETTING_KEY_OUTPUT_DIR, defaults.outputDir),
      perToolSubfolders: this.readBool(SETTING_KEY_PER_TOOL, defaults.perToolSubfolders),
      schemaVersion: SCHEMA_VERSION,
    };
  }

  /**
   * Applies a validated patch. Caller is responsible for passing only
   * values that already cleared `validatePatch()` — this method does
   * not re-validate. Returns the new settings.
   */
  apply(patch: SettingsPatch): RunnerSettings {
    const tx = this.db.transaction(() => {
      if (patch.outputDir !== undefined) {
        this.writeString(SETTING_KEY_OUTPUT_DIR, patch.outputDir);
      }
      if (patch.perToolSubfolders !== undefined) {
        this.writeString(SETTING_KEY_PER_TOOL, patch.perToolSubfolders ? "1" : "0");
      }
    });
    tx();
    return this.get();
  }

  /**
   * Resolves the on-disk output directory for a given runId / toolSlug.
   * Honours the `perToolSubfolders` flag. Creates intermediate
   * directories as needed.
   */
  resolveOutputDir(runId: string, toolSlug?: string): string {
    const s = this.get();
    const base = s.outputDir;
    let dir: string;
    if (s.perToolSubfolders && toolSlug && toolSlug.trim()) {
      // Sanitise the slug — only filesystem-safe characters allowed.
      const safe = toolSlug.replace(/[^a-zA-Z0-9_.-]/g, "_");
      dir = join(base, safe, runId);
    } else {
      dir = join(base, runId);
    }
    return dir;
  }

  private readString(key: string, fallback: string): string {
    const row = this.db
      .prepare(`SELECT value FROM settings WHERE key = ?`)
      .get(key) as { value: string } | undefined;
    return row?.value ?? fallback;
  }

  private readBool(key: string, fallback: boolean): boolean {
    const row = this.db
      .prepare(`SELECT value FROM settings WHERE key = ?`)
      .get(key) as { value: string } | undefined;
    if (row === undefined) return fallback;
    return row.value === "1" || row.value === "true";
  }

  private writeString(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }
}
