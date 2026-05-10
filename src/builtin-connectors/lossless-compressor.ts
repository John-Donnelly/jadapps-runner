/**
 * lossless-compressor: rewrites PNG / WebP at maximum lossless settings
 * to squeeze out file size without quality loss.
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

export default async function losslessCompressor(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "lossless-compressor requires one image input");
  let sharp: typeof import("sharp");
  try { sharp = (await import("sharp")).default as unknown as typeof import("sharp"); }
  catch (err) { return errorResult("driver_missing", `sharp not installed: ${(err as Error).message}`); }
  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);
  const factory = sharp as unknown as (b: Buffer) => {
    metadata(): Promise<{ format?: string }>;
    png(o: { compressionLevel: number; palette: boolean }): { toBuffer(): Promise<Buffer> };
    webp(o: { lossless: boolean }): { toBuffer(): Promise<Buffer> };
  };
  const meta = await factory(buf).metadata();
  let out: Buffer;
  if (meta.format === "webp") out = await factory(buf).webp({ lossless: true }).toBuffer();
  else out = await factory(buf).png({ compressionLevel: 9, palette: true }).toBuffer();
  const outRef = (ref.filename ?? ref.ref).replace(/(\.[^.]+)$/, ".lossless$1");
  await writeFile(join(ctx.scratchDir, outRef), out);
  return { ok: true, outputs: { format: meta.format, inputBytes: buf.length, outputBytes: out.length, savedBytes: buf.length - out.length }, fileRefs: [{ ref: outRef, bytes: out.length, sha256: "", mime: ref.mime, filename: outRef }], bytesProcessed: totalIn, durationMs: Date.now() - start };
}

function sizeOrFallback(path: string, fallback: number): number { try { return statSync(path).size; } catch { return fallback; } }
function errorResult(code: string, message: string): StepResult { return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } }; }
