/**
 * redundancy-analyzer: hashes every entry in a ZIP and reports duplicate
 * payloads (same sha256, different paths). Helps find wasted bytes
 * before re-compressing.
 */

import { readFile, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { StepResult, FileRef } from "../types.js";

interface ToolContext {
  toolId: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRef[];
  scratchDir: string;
  emitProgress(bytes: number): void;
}

export default async function redundancyAnalyzer(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "redundancy-analyzer requires one ZIP input");

  let JSZip: typeof import("jszip");
  try { JSZip = (await import("jszip")).default as unknown as typeof import("jszip"); }
  catch (err) { return errorResult("driver_missing", `jszip not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  const zip = await (JSZip as unknown as { loadAsync(b: Buffer): Promise<import("jszip")> }).loadAsync(buf);
  ctx.emitProgress(totalIn);

  const groups = new Map<string, { paths: string[]; bytes: number }>();
  for (const [path, file] of Object.entries(zip.files)) {
    if (file.dir) continue;
    const data = await file.async("nodebuffer");
    const hash = createHash("sha256").update(data).digest("hex");
    const existing = groups.get(hash);
    if (existing) existing.paths.push(path);
    else groups.set(hash, { paths: [path], bytes: data.length });
  }

  const dupes = [...groups.entries()]
    .filter(([, g]) => g.paths.length > 1)
    .map(([hash, g]) => ({ hash, paths: g.paths, bytes: g.bytes, wasted: g.bytes * (g.paths.length - 1) }))
    .sort((a, b) => b.wasted - a.wasted);

  const totalWasted = dupes.reduce((s, d) => s + d.wasted, 0);
  const summary = {
    archive: ref.filename ?? ref.ref,
    totalEntries: [...groups.values()].reduce((s, g) => s + g.paths.length, 0),
    uniquePayloads: groups.size,
    duplicateGroups: dupes.length,
    totalWastedBytes: totalWasted,
    duplicates: dupes,
  };
  const out = JSON.stringify(summary, null, 2);
  const outRef = "redundancy-report.json";
  await writeFile(join(ctx.scratchDir, outRef), out, "utf8");

  return {
    ok: true,
    outputs: { duplicateGroups: dupes.length, totalWastedBytes: totalWasted, uniquePayloads: groups.size },
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
