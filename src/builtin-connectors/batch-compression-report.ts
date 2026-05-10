/**
 * batch-compression-report: for a set of ZIPs, computes per-archive and
 * aggregate compression stats — original vs compressed bytes, ratio,
 * average per-entry savings.
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

export default async function batchCompressionReport(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  if (!Array.isArray(ctx.fileRefs) || ctx.fileRefs.length === 0) {
    return errorResult("missing_input", "batch-compression-report requires at least one ZIP input");
  }

  let JSZip: typeof import("jszip");
  try { JSZip = (await import("jszip")).default as unknown as typeof import("jszip"); }
  catch (err) { return errorResult("driver_missing", `jszip not installed: ${(err as Error).message}`); }

  const archives: { name: string; entries: number; uncompressed: number; compressed: number; ratio: number }[] = [];
  let totalIn = 0;
  let totalUncompressed = 0;
  let totalCompressed = 0;

  for (const ref of ctx.fileRefs) {
    const path = join(ctx.scratchDir, ref.ref);
    const inSize = sizeOrFallback(path, ref.bytes);
    totalIn += inSize;
    const buf = await readFile(path);
    if (buf[0] !== 0x50 || buf[1] !== 0x4b) continue;
    const zip = await (JSZip as unknown as { loadAsync(b: Buffer): Promise<import("jszip")> }).loadAsync(buf);
    let uncompressed = 0;
    let compressed = 0;
    let entries = 0;
    for (const file of Object.values(zip.files)) {
      if (file.dir) continue;
      const internal = (file as unknown as { _data?: { uncompressedSize?: number; compressedSize?: number } })._data;
      if (internal?.uncompressedSize != null) uncompressed += internal.uncompressedSize;
      if (internal?.compressedSize != null) compressed += internal.compressedSize;
      entries += 1;
    }
    if (compressed === 0) compressed = inSize;
    const ratio = uncompressed > 0 ? compressed / uncompressed : 1;
    archives.push({ name: ref.filename ?? ref.ref, entries, uncompressed, compressed, ratio });
    totalUncompressed += uncompressed;
    totalCompressed += compressed;
  }
  ctx.emitProgress(totalIn);

  const aggregate = {
    archiveCount: archives.length,
    totalUncompressed,
    totalCompressed,
    overallRatio: totalUncompressed > 0 ? totalCompressed / totalUncompressed : 1,
    savedBytes: totalUncompressed - totalCompressed,
    archives,
  };
  const out = JSON.stringify(aggregate, null, 2);
  const outRef = "compression-report.json";
  await writeFile(join(ctx.scratchDir, outRef), out, "utf8");

  return {
    ok: true,
    outputs: {
      archiveCount: archives.length,
      overallRatio: aggregate.overallRatio,
      savedBytes: aggregate.savedBytes,
    },
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
