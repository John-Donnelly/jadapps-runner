import { mkdirSync, rmSync, existsSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Per-run scratch dir manager. Files referenced by `FileRef.ref` resolve to
 * paths inside the run's dir. Caller is responsible for `release(runId)` when
 * the run ends.
 */
export class ScratchManager {
  constructor(private readonly base: string) {}

  get basePath(): string {
    return this.base;
  }

  acquire(runId?: string): string {
    const id = runId ?? randomUUID();
    const dir = join(this.base, id);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  release(runId: string): void {
    const dir = join(this.base, runId);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }

  resolve(runId: string, ref: string): string {
    if (ref.includes("..") || ref.startsWith("/") || ref.includes("\\")) {
      throw new Error("invalid scratch ref");
    }
    return join(this.base, runId, ref);
  }

  /** Sweep abandoned dirs older than `maxAgeMs`. Called on startup. */
  sweepStale(maxAgeMs: number): number {
    if (!existsSync(this.base)) return 0;
    let removed = 0;
    const now = Date.now();
    for (const entry of readdirSync(this.base)) {
      const path = join(this.base, entry);
      try {
        const st = statSync(path);
        if (now - st.mtimeMs > maxAgeMs) {
          rmSync(path, { recursive: true, force: true });
          removed++;
        }
      } catch {
        /* ignore */
      }
    }
    return removed;
  }
}
