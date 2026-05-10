/**
 * lossy-compressor: aggressive JPEG/WebP/AVIF re-encode for the
 * smallest possible file at acceptable visual quality.
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

export default async function lossyCompressor(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "lossy-compressor requires one image input");
  let sharp: typeof import("sharp");
  try { sharp = (await import("sharp")).default as unknown as typeof import("sharp"); }
  catch (err) { return errorResult("driver_missing", `sharp not installed: ${(err as Error).message}`); }
  const cfg = ctx.inputs ?? {};
  const quality = Math.max(1, Math.min(100, Number(cfg.quality ?? 50)));
  const targetFormat = String(cfg.format ?? "webp").toLowerCase();
  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);
  const factory = sharp as unknown as (b: Buffer) => {
    jpeg(o: { quality: number; mozjpeg: boolean }): { toBuffer(): Promise<Buffer> };
    webp(o: { quality: number; effort: number }): { toBuffer(): Promise<Buffer> };
    avif(o: { quality: number; effort: number }): { toBuffer(): Promise<Buffer> };
  };
  let out: Buffer;
  let mime: string;
  let ext: string;
  if (targetFormat === "avif") { out = await factory(buf).avif({ quality, effort: 6 }).toBuffer(); mime = "image/avif"; ext = ".avif"; }
  else if (targetFormat === "jpeg" || targetFormat === "jpg") { out = await factory(buf).jpeg({ quality, mozjpeg: true }).toBuffer(); mime = "image/jpeg"; ext = ".jpg"; }
  else { out = await factory(buf).webp({ quality, effort: 6 }).toBuffer(); mime = "image/webp"; ext = ".webp"; }
  const outRef = (ref.filename ?? ref.ref).replace(/\.[^.]+$/, ext);
  await writeFile(join(ctx.scratchDir, outRef), out);
  return { ok: true, outputs: { format: targetFormat, quality, inputBytes: buf.length, outputBytes: out.length, savedBytes: buf.length - out.length }, fileRefs: [{ ref: outRef, bytes: out.length, sha256: "", mime, filename: outRef }], bytesProcessed: totalIn, durationMs: Date.now() - start };
}

function sizeOrFallback(path: string, fallback: number): number { try { return statSync(path).size; } catch { return fallback; } }
function errorResult(code: string, message: string): StepResult { return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } }; }
