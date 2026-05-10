/**
 * archive-size-analyzer: reports the largest files inside an archive plus
 * summary stats (total bytes, average, median, p95). Useful before sharing
 * an archive to spot accidental inclusions.
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

export default async function archiveSizeAnalyzer(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "archive-size-analyzer requires one archive input");
  const cfg = ctx.inputs ?? {};
  const topN = Math.max(5, Math.min(100, Math.floor(Number(cfg.topN ?? 20))));

  let JSZip: typeof import("jszip");
  try { JSZip = (await import("jszip")).default as unknown as typeof import("jszip"); }
  catch (err) { return errorResult("driver_missing", `jszip not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  const zip = await (JSZip as unknown as { loadAsync(b: Buffer): Promise<import("jszip")> }).loadAsync(buf);
  ctx.emitProgress(totalIn);

  interface Entry { path: string; uncompressed: number; compressed: number; }
  const entries: Entry[] = [];
  for (const [path, file] of Object.entries(zip.files)) {
    if (file.dir) continue;
    const data = (file as unknown as { _data?: { uncompressedSize?: number; compressedSize?: number } })._data ?? {};
    entries.push({ path, uncompressed: data.uncompressedSize ?? 0, compressed: data.compressedSize ?? 0 });
  }

  const sizes = entries.map((e) => e.uncompressed).sort((a, b) => a - b);
  const totalBytes = sizes.reduce((a, b) => a + b, 0);
  const median = sizes.length === 0 ? 0 : sizes[Math.floor(sizes.length / 2)]!;
  const p95 = sizes.length === 0 ? 0 : sizes[Math.floor(sizes.length * 0.95)]!;
  const top = [...entries].sort((a, b) => b.uncompressed - a.uncompressed).slice(0, topN);

  const report = {
    archiveBytes: totalIn,
    totalUncompressed: totalBytes,
    fileCount: entries.length,
    averageBytes: entries.length === 0 ? 0 : Math.round(totalBytes / entries.length),
    medianBytes: median,
    p95Bytes: p95,
    largest: top,
  };
  const out = JSON.stringify(report, null, 2);
  const outRef = "size-analysis.json";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, out, "utf8");

  return {
    ok: true,
    outputs: report,
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
