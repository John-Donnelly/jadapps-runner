/**
 * compression-level-optimizer: re-compresses a ZIP at multiple DEFLATE
 * levels (1, 5, 9) and reports size at each level so the user can pick
 * the level that wins on their corpus. Returns the smallest output as
 * the artifact.
 */

import { readFile, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { join } from "node:path";
import type { StepResult, FileRef } from "../types.js";

interface ToolContext {
  toolId: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRef[];
  scratchDir: string;
  emitProgress(bytes: number): void;
}

export default async function compressionLevelOptimizer(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "compression-level-optimizer requires one ZIP input");

  let JSZip: typeof import("jszip");
  try { JSZip = (await import("jszip")).default as unknown as typeof import("jszip"); }
  catch (err) { return errorResult("driver_missing", `jszip not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  const zip = await (JSZip as unknown as { loadAsync(b: Buffer): Promise<import("jszip")> }).loadAsync(buf);
  ctx.emitProgress(totalIn);

  // Re-add every entry into a fresh zip so we have raw data to recompress at any level.
  const entryData: { path: string; data: Buffer }[] = [];
  for (const [path, file] of Object.entries(zip.files)) {
    if (file.dir) continue;
    entryData.push({ path, data: await file.async("nodebuffer") });
  }

  const levels = [1, 5, 9];
  const trials: { level: number; bytes: number; durationMs: number }[] = [];
  let best = { level: 9, bytes: Number.POSITIVE_INFINITY, buf: Buffer.alloc(0) };
  for (const level of levels) {
    const z = new (JSZip as unknown as new () => import("jszip"))();
    for (const { path, data } of entryData) z.file(path, data);
    const t0 = Date.now();
    const out = await z.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level },
    });
    const dt = Date.now() - t0;
    trials.push({ level, bytes: out.length, durationMs: dt });
    if (out.length < best.bytes) best = { level, bytes: out.length, buf: Buffer.from(out) };
  }

  const outRef = (ref.filename ?? ref.ref).replace(/\.zip$/i, `.optimized.zip`);
  await writeFile(join(ctx.scratchDir, outRef), best.buf);
  const reportRef = "compression-trials.json";
  const report = { archive: ref.filename ?? ref.ref, originalBytes: buf.length, trials, bestLevel: best.level, bestBytes: best.bytes };
  await writeFile(join(ctx.scratchDir, reportRef), JSON.stringify(report, null, 2), "utf8");

  return {
    ok: true,
    outputs: { bestLevel: best.level, bestBytes: best.bytes, originalBytes: buf.length, savedBytes: buf.length - best.bytes },
    fileRefs: [
      { ref: outRef, bytes: best.buf.length, sha256: "", mime: "application/zip", filename: outRef },
      { ref: reportRef, bytes: Buffer.byteLength(JSON.stringify(report)), sha256: "", mime: "application/json", filename: reportRef },
    ],
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
