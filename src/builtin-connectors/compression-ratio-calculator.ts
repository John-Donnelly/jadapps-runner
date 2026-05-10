/**
 * compression-ratio-calculator: for a single ZIP, walks each entry and
 * computes the per-entry compression ratio (compressed / uncompressed).
 * Output is a JSON report with min/max/mean/median ratios.
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

export default async function compressionRatioCalculator(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "compression-ratio-calculator requires one ZIP input");

  let JSZip: typeof import("jszip");
  try { JSZip = (await import("jszip")).default as unknown as typeof import("jszip"); }
  catch (err) { return errorResult("driver_missing", `jszip not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  const zip = await (JSZip as unknown as { loadAsync(b: Buffer): Promise<import("jszip")> }).loadAsync(buf);
  ctx.emitProgress(totalIn);

  const entries: { path: string; uncompressed: number; compressed: number; ratio: number }[] = [];
  for (const [path, file] of Object.entries(zip.files)) {
    if (file.dir) continue;
    const data = await file.async("nodebuffer");
    const internal = (file as unknown as { _data?: { compressedSize?: number } })._data;
    const compressed = internal?.compressedSize ?? data.length;
    const ratio = data.length > 0 ? compressed / data.length : 1;
    entries.push({ path, uncompressed: data.length, compressed, ratio });
  }

  const ratios = entries.map((e) => e.ratio).sort((a, b) => a - b);
  const sum = ratios.reduce((s, r) => s + r, 0);
  const mid = Math.floor(ratios.length / 2);
  const median = ratios.length === 0 ? 0 : (ratios.length % 2 ? ratios[mid] ?? 0 : ((ratios[mid - 1] ?? 0) + (ratios[mid] ?? 0)) / 2);
  const summary = {
    archive: ref.filename ?? ref.ref,
    entryCount: entries.length,
    minRatio: ratios[0] ?? 1,
    maxRatio: ratios[ratios.length - 1] ?? 1,
    meanRatio: ratios.length === 0 ? 1 : sum / ratios.length,
    medianRatio: median,
    entries,
  };
  const out = JSON.stringify(summary, null, 2);
  const outRef = "ratio-report.json";
  await writeFile(join(ctx.scratchDir, outRef), out, "utf8");

  return {
    ok: true,
    outputs: { entryCount: entries.length, meanRatio: summary.meanRatio, medianRatio: summary.medianRatio },
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
