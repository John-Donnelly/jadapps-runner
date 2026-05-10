/**
 * file-type-breakdown: groups archive entries by file extension and
 * reports counts + total bytes per extension. Useful for "what's
 * actually in this archive" overviews.
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

export default async function fileTypeBreakdown(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "file-type-breakdown requires one archive input");

  let JSZip: typeof import("jszip");
  try { JSZip = (await import("jszip")).default as unknown as typeof import("jszip"); }
  catch (err) { return errorResult("driver_missing", `jszip not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  const zip = await (JSZip as unknown as { loadAsync(b: Buffer): Promise<import("jszip")> }).loadAsync(buf);
  ctx.emitProgress(totalIn);

  const breakdown = new Map<string, { count: number; bytes: number }>();
  for (const [path, file] of Object.entries(zip.files)) {
    if (file.dir) continue;
    const ext = (path.split("/").pop() ?? "").split(".").pop()?.toLowerCase() ?? "(no-ext)";
    const size = ((file as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize) ?? 0;
    const stats = breakdown.get(ext) ?? { count: 0, bytes: 0 };
    stats.count += 1;
    stats.bytes += size;
    breakdown.set(ext, stats);
  }

  const summary = [...breakdown.entries()]
    .map(([ext, stats]) => ({ extension: ext, count: stats.count, bytes: stats.bytes }))
    .sort((a, b) => b.bytes - a.bytes);

  const out = JSON.stringify({ totalExtensions: summary.length, totalFiles: summary.reduce((s, e) => s + e.count, 0), breakdown: summary }, null, 2);
  const outRef = "type-breakdown.json";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, out, "utf8");

  return {
    ok: true,
    outputs: { totalExtensions: summary.length, breakdown: summary.slice(0, 10) },
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
