import { writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";

const SERVICE = "jadapps-runner";

interface KeychainAdapter {
  setPassword(account: string, value: string): Promise<void>;
  getPassword(account: string): Promise<string | null>;
  deletePassword(account: string): Promise<boolean>;
}

let adapter: KeychainAdapter | null = null;
let adapterError: Error | null = null;

async function getAdapter(): Promise<KeychainAdapter | null> {
  if (adapter) return adapter;
  if (adapterError) return null;
  try {
    const keytar = (await import("keytar")) as unknown as {
      setPassword(s: string, a: string, p: string): Promise<void>;
      getPassword(s: string, a: string): Promise<string | null>;
      deletePassword(s: string, a: string): Promise<boolean>;
    };
    adapter = {
      setPassword: (account, value) => keytar.setPassword(SERVICE, account, value),
      getPassword: (account) => keytar.getPassword(SERVICE, account),
      deletePassword: (account) => keytar.deletePassword(SERVICE, account),
    };
    return adapter;
  } catch (err) {
    adapterError = err as Error;
    return null;
  }
}

/**
 * Stores secrets in OS keychain when available, falling back to a 0600
 * file in the runner data dir. The fallback is documented as less-secure;
 * the runner warns at startup if it's in use.
 */
export class SecretStore {
  constructor(private readonly fallbackDir: string) {}

  async set(account: string, value: string): Promise<void> {
    const a = await getAdapter();
    if (a) {
      await a.setPassword(account, value);
      return;
    }
    const path = this.fallbackPath(account);
    writeFileSync(path, value, { encoding: "utf8" });
    try {
      chmodSync(path, 0o600);
    } catch {
      // Windows: chmod is a no-op; ACLs are enforced by the user dir.
    }
  }

  async get(account: string): Promise<string | null> {
    const a = await getAdapter();
    if (a) return a.getPassword(account);
    const path = this.fallbackPath(account);
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8");
  }

  async delete(account: string): Promise<boolean> {
    const a = await getAdapter();
    if (a) return a.deletePassword(account);
    const path = this.fallbackPath(account);
    if (!existsSync(path)) return false;
    writeFileSync(path, "", { encoding: "utf8" });
    return true;
  }

  isUsingFallback(): boolean {
    return adapter === null && adapterError !== null;
  }

  private fallbackPath(account: string): string {
    const safe = account.replace(/[^a-zA-Z0-9_.-]/g, "_");
    return join(this.fallbackDir, `secret.${safe}`);
  }
}
