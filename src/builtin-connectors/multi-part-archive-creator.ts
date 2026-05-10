/**
 * multi-part-archive-creator: bundles inputs into a single ZIP, then
 * writes that ZIP back to disk as fixed-size byte chunks (.001, .002,
 * ...). Mimics RAR-style "split archive" output. Reassembly is plain
 * `cat` of parts in order.
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

export default async function multiPartArchiveCreator(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  if (!Array.isArray(ctx.fileRefs) || ctx.fileRefs.length === 0) {
    return errorResult("missing_input", "multi-part-archive-creator requires at least one input");
  }
  const cfg = ctx.inputs ?? {};
  const partBytes = Math.max(1024 * 1024, Number(cfg.partSizeBytes ?? 50 * 1024 * 1024));

  let JSZip: typeof import("jszip");
  try { JSZip = (await import("jszip")).default as unknown as typeof import("jszip"); }
  catch (err) { return errorResult("driver_missing", `jszip not installed: ${(err as Error).message}`); }

  const zip = new (JSZip as unknown as new () => import("jszip"))();
  let totalIn = 0;
  for (const ref of ctx.fileRefs) {
    const path = join(ctx.scratchDir, ref.ref);
    totalIn += sizeOrFallback(path, ref.bytes);
    zip.file(ref.filename ?? ref.ref, await readFile(path));
  }
  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  ctx.emitProgress(totalIn);

  const fileRefs: FileRef[] = [];
  const baseName = "archive";
  let part = 1;
  for (let pos = 0; pos < buf.length; pos += partBytes) {
    const slice = buf.subarray(pos, Math.min(pos + partBytes, buf.length));
    const partRef = `${baseName}.zip.${part.toString().padStart(3, "0")}`;
    await writeFile(join(ctx.scratchDir, partRef), slice);
    fileRefs.push({ ref: partRef, bytes: slice.length, sha256: "", mime: "application/octet-stream", filename: partRef });
    part += 1;
  }

  return {
    ok: true,
    outputs: { partCount: fileRefs.length, totalBytes: buf.length, partSizeBytes: partBytes },
    fileRefs,
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
