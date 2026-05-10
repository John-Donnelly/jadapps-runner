/**
 * bulk-compressor: applies the same compression to every image input,
 * returning the compressed batch as individual fileRefs.
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

export default async function bulkCompressor(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  if (!Array.isArray(ctx.fileRefs) || ctx.fileRefs.length === 0) {
    return errorResult("missing_input", "bulk-compressor requires at least one image input");
  }
  let sharp: typeof import("sharp");
  try { sharp = (await import("sharp")).default as unknown as typeof import("sharp"); }
  catch (err) { return errorResult("driver_missing", `sharp not installed: ${(err as Error).message}`); }
  const cfg = ctx.inputs ?? {};
  const quality = Math.max(1, Math.min(100, Number(cfg.quality ?? 75)));
  const factory = sharp as unknown as (b: Buffer) => {
    metadata(): Promise<{ format?: string }>;
    jpeg(o: { quality: number }): { toBuffer(): Promise<Buffer> };
    webp(o: { quality: number }): { toBuffer(): Promise<Buffer> };
    png(o: { compressionLevel: number }): { toBuffer(): Promise<Buffer> };
  };
  const fileRefs: FileRef[] = [];
  let totalIn = 0, totalOut = 0;
  for (const ref of ctx.fileRefs) {
    const path = join(ctx.scratchDir, ref.ref);
    totalIn += sizeOrFallback(path, ref.bytes);
    const buf = await readFile(path);
    const meta = await factory(buf).metadata();
    let out: Buffer;
    switch (meta.format) {
      case "jpeg": out = await factory(buf).jpeg({ quality }).toBuffer(); break;
      case "webp": out = await factory(buf).webp({ quality }).toBuffer(); break;
      case "png": default: out = await factory(buf).png({ compressionLevel: 9 }).toBuffer(); break;
    }
    totalOut += out.length;
    const outName = (ref.filename ?? ref.ref).replace(/(\.[^.]+)$/, ".compressed$1");
    await writeFile(join(ctx.scratchDir, outName), out);
    fileRefs.push({ ref: outName, bytes: out.length, sha256: "", mime: ref.mime, filename: outName });
  }
  ctx.emitProgress(totalIn);
  return { ok: true, outputs: { fileCount: ctx.fileRefs.length, totalInputBytes: totalIn, totalOutputBytes: totalOut, savedBytes: totalIn - totalOut }, fileRefs, bytesProcessed: totalIn, durationMs: Date.now() - start };
}

function sizeOrFallback(path: string, fallback: number): number { try { return statSync(path).size; } catch { return fallback; } }
function errorResult(code: string, message: string): StepResult { return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } }; }
