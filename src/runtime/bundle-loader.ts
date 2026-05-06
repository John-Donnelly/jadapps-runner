import { createHash } from "node:crypto";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiClient } from "../api/client.js";
import type { Logger } from "../log.js";
import type { ToolBundleRef } from "../types.js";
import { decryptJson } from "../credentials/crypto.js";

interface LoadedBundle {
  toolId: string;
  modulePath: string;
  cleanup: () => void;
}

/**
 * Fetches, verifies, decrypts, and stages tool bundles for the worker pool.
 * Bundles are loaded into a private temp dir per process and removed on cleanup.
 *
 * Bundle wire format (v0.1):
 *   { encrypted: false, toolId, code: <utf8> }                  — dev / free tier
 *   { encrypted: true,  toolId, blob: <aes-gcm base64> }        — paid tier
 *
 * Decrypted form is always `{ toolId: string; code: string }` where `code` is a
 * full ESM module body. The worker writes it to a `.mjs` and dynamic-imports it.
 */
export class BundleLoader {
  private cache = new Map<string, Promise<LoadedBundle>>();
  private stagingDir: string;

  constructor(
    private readonly api: ApiClient,
    private readonly log: Logger,
  ) {
    this.stagingDir = mkdtempSync(join(tmpdir(), "jadapps-bundles-"));
  }

  async load(ref: ToolBundleRef, accessJwt: string): Promise<LoadedBundle> {
    const cached = this.cache.get(ref.bundleSha256);
    if (cached) return cached;
    const promise = this.fetchAndStage(ref, accessJwt);
    this.cache.set(ref.bundleSha256, promise);
    return promise;
  }

  private async fetchAndStage(ref: ToolBundleRef, accessJwt: string): Promise<LoadedBundle> {
    const buf = await this.api.fetchBundle(ref.bundleUrl, accessJwt);
    const sha = createHash("sha256").update(buf).digest("hex");
    if (sha !== ref.bundleSha256) {
      throw new Error(`bundle sha mismatch for ${ref.toolId}`);
    }

    const envelope = JSON.parse(buf.toString("utf8")) as
      | { encrypted: false; toolId: string; code: string }
      | { encrypted: true; toolId: string; blob: string };

    let code: string;
    if (envelope.encrypted) {
      if (!ref.decryptionKey) {
        throw new Error(`bundle ${ref.toolId} is encrypted but no key provided`);
      }
      const decoded = decryptJson<{ code: string }>(ref.decryptionKey, envelope.blob);
      code = decoded.code;
    } else {
      code = envelope.code;
    }

    const filename = `${envelope.toolId.replace(/[^a-zA-Z0-9_-]/g, "_")}-${sha.slice(0, 12)}.mjs`;
    const modulePath = join(this.stagingDir, filename);
    writeFileSync(modulePath, code, { encoding: "utf8" });

    return {
      toolId: envelope.toolId,
      modulePath,
      cleanup: () => {
        try {
          rmSync(modulePath, { force: true });
        } catch {
          /* ignore */
        }
      },
    };
  }

  shutdown() {
    try {
      rmSync(this.stagingDir, { recursive: true, force: true });
    } catch (err) {
      this.log.warn({ err }, "failed to clean bundle staging dir");
    }
  }
}
