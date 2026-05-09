/**
 * file-integrity-monitor: compares a baseline manifest of file hashes
 * against the current file set. Reports added, removed, and changed files.
 *
 * The baseline manifest is a JSON file produced by hash-files (or a
 * compatible map of {ref → hex} pairs); the current set is everything else
 * in the input list (all subsequent fileRefs).
 */

import { createReadStream, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { StepResult, FileRef } from "../types.js";

interface ToolContext {
  toolId: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRef[];
  scratchDir: string;
  emitProgress(bytes: number): void;
}

interface Diff { added: string[]; removed: string[]; changed: { name: string; before: string; after: string }[]; unchanged: string[]; }

export default async function fileIntegrityMonitor(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  if (!Array.isArray(ctx.fileRefs) || ctx.fileRefs.length < 2) {
    return errorResult("missing_input", "file-integrity-monitor requires a baseline JSON plus at least one file to compare");
  }
  const baselineRef = ctx.fileRefs[0]!;
  const baselinePath = join(ctx.scratchDir, baselineRef.ref);
  const baselineRaw = await readFile(baselinePath, "utf8");
  let baseline: Record<string, string>;
  try {
    const parsed = JSON.parse(baselineRaw) as { results?: Array<{ filename?: string; hex?: string }> } | Record<string, string>;
    if (parsed && typeof parsed === "object" && "results" in parsed && Array.isArray((parsed as { results?: unknown[] }).results)) {
      baseline = {};
      for (const r of ((parsed as { results: Array<{ filename?: string; hex?: string }> }).results)) {
        if (r.filename && r.hex) baseline[r.filename] = r.hex;
      }
    } else {
      baseline = parsed as Record<string, string>;
    }
  } catch (err) {
    return errorResult("invalid_baseline", `baseline isn't valid JSON: ${(err as Error).message}`);
  }

  const cfg = ctx.inputs ?? {};
  const algorithm = String(cfg.algorithm ?? "sha256");

  const current: Record<string, string> = {};
  let totalIn = sizeOrFallback(baselinePath, baselineRef.bytes);
  for (let i = 1; i < ctx.fileRefs.length; i++) {
    const ref = ctx.fileRefs[i]!;
    const path = join(ctx.scratchDir, ref.ref);
    totalIn += sizeOrFallback(path, ref.bytes);
    const hash = createHash(algorithm);
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(path);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("end", () => resolve());
      stream.on("error", reject);
    });
    current[ref.filename] = hash.digest("hex");
  }
  ctx.emitProgress(totalIn);

  const diff: Diff = { added: [], removed: [], changed: [], unchanged: [] };
  for (const [name, hex] of Object.entries(current)) {
    const baselineHex = baseline[name];
    if (!baselineHex) diff.added.push(name);
    else if (baselineHex !== hex) diff.changed.push({ name, before: baselineHex, after: hex });
    else diff.unchanged.push(name);
  }
  for (const name of Object.keys(baseline)) if (!(name in current)) diff.removed.push(name);

  const out = JSON.stringify({ algorithm, baselineCount: Object.keys(baseline).length, currentCount: Object.keys(current).length, diff }, null, 2);
  const outRef = "integrity-report.json";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, out, "utf8");

  return {
    ok: true,
    outputs: { addedCount: diff.added.length, removedCount: diff.removed.length, changedCount: diff.changed.length, unchangedCount: diff.unchanged.length, integrityIntact: diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0 },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(out, "utf8"), sha256: "", mime: "application/json", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
