/**
 * image-upscaler: upscales an image by 2x, 3x, or 4x using sharp's
 * high-quality Lanczos resampling. Not an ML-based super-resolution
 * upscaler — for that, integrate a model in a follow-up tool. Useful for
 * doubling/quadrupling pixel density before printing or display.
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

export default async function imageUpscaler(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "image-upscaler requires one image input");

  const cfg = ctx.inputs ?? {};
  const factor = Math.max(2, Math.min(4, Math.floor(Number(cfg.factor ?? 2))));
  const format = ["png", "jpg", "jpeg", "webp"].includes(cfg.format as string) ? cfg.format as "png" | "jpg" | "jpeg" | "webp" : null;
  const quality = Math.max(1, Math.min(100, Math.floor(Number(cfg.quality ?? 90))));

  let sharpMod: typeof import("sharp");
  try { sharpMod = (await import("sharp")).default as unknown as typeof import("sharp"); }
  catch (err) { return errorResult("driver_missing", `sharp not installed: ${(err as Error).message}`); }
  const sharp = sharpMod as unknown as (input?: Buffer) => import("sharp").Sharp;

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  const pipeline = sharp(buf);
  const meta = await pipeline.metadata();
  const newW = (meta.width ?? 1) * factor;
  const newH = (meta.height ?? 1) * factor;

  let upscalePipeline = sharp(buf).resize({ width: newW, height: newH, kernel: "lanczos3", fit: "fill" });
  let outFormat: string;
  if (format === "jpg" || format === "jpeg") { upscalePipeline = upscalePipeline.jpeg({ quality }); outFormat = "jpg"; }
  else if (format === "webp") { upscalePipeline = upscalePipeline.webp({ quality }); outFormat = "webp"; }
  else if (format === "png") { upscalePipeline = upscalePipeline.png(); outFormat = "png"; }
  else { outFormat = (meta.format === "jpeg" ? "jpg" : meta.format) ?? "png"; }

  const out = await upscalePipeline.toBuffer();
  const baseName = (ref.filename ?? ref.ref).replace(/\.[^.]+$/, "");
  const outRef = `${baseName}-${factor}x.${outFormat}`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, out);
  ctx.emitProgress(totalIn);

  const mime = outFormat === "jpg" ? "image/jpeg" : `image/${outFormat}`;
  return {
    ok: true,
    outputs: { factor, originalWidth: meta.width ?? null, originalHeight: meta.height ?? null, newWidth: newW, newHeight: newH },
    fileRefs: [{ ref: outRef, bytes: out.length, sha256: "", mime, filename: outRef }],
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
