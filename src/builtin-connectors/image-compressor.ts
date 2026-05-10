/**
 * image-compressor: re-encodes an image at a configured quality,
 * keeping the same format (JPEG/WebP/AVIF/PNG).
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

export default async function imageCompressor(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "image-compressor requires one image input");
  let sharp: typeof import("sharp");
  try { sharp = (await import("sharp")).default as unknown as typeof import("sharp"); }
  catch (err) { return errorResult("driver_missing", `sharp not installed: ${(err as Error).message}`); }
  const cfg = ctx.inputs ?? {};
  const quality = Math.max(1, Math.min(100, Number(cfg.quality ?? 75)));
  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);
  const factory = sharp as unknown as (b: Buffer) => {
    metadata(): Promise<{ format?: string }>;
    jpeg(o: { quality: number }): { toBuffer(): Promise<Buffer> };
    webp(o: { quality: number }): { toBuffer(): Promise<Buffer> };
    avif(o: { quality: number }): { toBuffer(): Promise<Buffer> };
    png(o: { compressionLevel: number }): { toBuffer(): Promise<Buffer> };
  };
  const meta = await factory(buf).metadata();
  let out: Buffer;
  switch (meta.format) {
    case "jpeg": out = await factory(buf).jpeg({ quality }).toBuffer(); break;
    case "webp": out = await factory(buf).webp({ quality }).toBuffer(); break;
    case "avif": out = await factory(buf).avif({ quality }).toBuffer(); break;
    case "png": default: out = await factory(buf).png({ compressionLevel: 9 }).toBuffer(); break;
  }
  const outRef = (ref.filename ?? ref.ref).replace(/(\.[^.]+)$/, ".compressed$1");
  await writeFile(join(ctx.scratchDir, outRef), out);
  return { ok: true, outputs: { format: meta.format, quality, inputBytes: buf.length, outputBytes: out.length, savedBytes: buf.length - out.length }, fileRefs: [{ ref: outRef, bytes: out.length, sha256: "", mime: ref.mime, filename: outRef }], bytesProcessed: totalIn, durationMs: Date.now() - start };
}

function sizeOrFallback(path: string, fallback: number): number { try { return statSync(path).size; } catch { return fallback; } }
function errorResult(code: string, message: string): StepResult { return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } }; }
