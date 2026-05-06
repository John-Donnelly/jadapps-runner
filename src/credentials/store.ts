import Database from "better-sqlite3";
import type { Credential } from "../types.js";
import type { SecretStore } from "../auth/keychain.js";
import { decryptJson, encryptJson, generateMasterKey } from "./crypto.js";

const MASTER_KEY_ACCOUNT = "vault_master_key";

export class CredentialStore {
  private db!: Database.Database;
  private master!: string;

  constructor(
    private readonly sqlitePath: string,
    private readonly secrets: SecretStore,
  ) {}

  async init(): Promise<void> {
    let master = await this.secrets.get(MASTER_KEY_ACCOUNT);
    if (!master) {
      master = generateMasterKey();
      await this.secrets.set(MASTER_KEY_ACCOUNT, master);
    }
    this.master = master;
    this.db = new Database(this.sqlitePath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS credentials (
        ref         TEXT PRIMARY KEY,
        type        TEXT NOT NULL,
        ciphertext  TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS event_queue (
        seq         INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id      TEXT NOT NULL,
        payload     TEXT NOT NULL,
        ts          INTEGER NOT NULL,
        attempts    INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  list(): Credential[] {
    const rows = this.db
      .prepare(`SELECT ref, type, ciphertext, created_at, updated_at FROM credentials`)
      .all() as Array<{
      ref: string;
      type: Credential["type"];
      ciphertext: string;
      created_at: number;
      updated_at: number;
    }>;
    return rows.map((r) => ({
      ref: r.ref,
      type: r.type,
      data: decryptJson<Record<string, unknown>>(this.master, r.ciphertext),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  get(ref: string): Credential | null {
    const row = this.db
      .prepare(`SELECT ref, type, ciphertext, created_at, updated_at FROM credentials WHERE ref = ?`)
      .get(ref) as
      | { ref: string; type: Credential["type"]; ciphertext: string; created_at: number; updated_at: number }
      | undefined;
    if (!row) return null;
    return {
      ref: row.ref,
      type: row.type,
      data: decryptJson(this.master, row.ciphertext),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  upsert(ref: string, type: Credential["type"], data: Record<string, unknown>): void {
    const ciphertext = encryptJson(this.master, data);
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO credentials (ref, type, ciphertext, created_at, updated_at)
         VALUES (@ref, @type, @ciphertext, @now, @now)
         ON CONFLICT(ref) DO UPDATE SET
           type = excluded.type,
           ciphertext = excluded.ciphertext,
           updated_at = excluded.updated_at`,
      )
      .run({ ref, type, ciphertext, now });
  }

  delete(ref: string): boolean {
    return this.db.prepare(`DELETE FROM credentials WHERE ref = ?`).run(ref).changes > 0;
  }

  rawDb(): Database.Database {
    return this.db;
  }
}
