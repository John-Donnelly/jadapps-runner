/**
 * image-resizer: resizes one or more images using sharp. Supports fit modes
 * (cover, contain, fill, inside, outside), and preserves the source format
 * unless `format` is set to "png" | "jpg" | "webp" | "avif".
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

export default async function imageResizer(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  if (!Array.isArray(ctx.fileRefs) || ctx.fileRefs.length === 0) {
    return errorResult("missing_input", "image-resizer requires at least one image");
  }

  const cfg = ctx.inputs ?? {};
  const width = cfg.width != null ? Math.max(1, Math.min(20000, Math.floor(Number(cfg.width)))) : null;
  const height = cfg.height != null ? Math.max(1, Math.min(20000, Math.floor(Number(cfg.height)))) : null;
  if (width == null && height == null) return errorResult("invalid_config", "at least one of width or height is required");
  const fit = ["cover", "contain", "fill", "inside", "outside"].includes(cfg.fit as string) ? cfg.fit as "cover" | "contain" | "fill" | "inside" | "outside" : "inside";
  const format = ["png", "jpg", "jpeg", "webp", "avif"].includes(cfg.format as string) ? cfg.format as "png" | "jpg" | "jpeg" | "webp" | "avif" : null;
  const quality = Math.max(1, Math.min(100, Math.floor(Number(cfg.quality ?? 85))));

  let sharpMod: typeof import("sharp");
  try { sharpMod = (await import("sharp")).default as unknown as typeof import("sharp"); }
  catch (err) { return errorResult("driver_missing", `sharp not installed: ${(err as Error).message}`); }
  const sharp = sharpMod as unknown as (input?: Buffer) => import("sharp").Sharp;

  const fileRefs: FileRef[] = [];
  let totalIn = 0;
  for (const ref of ctx.fileRefs) {
    const path = join(ctx.scratchDir, ref.ref);
    totalIn += sizeOrFallback(path, ref.bytes);
    const buf = await readFile(path);
    let pipeline = sharp(buf).resize({ width: width ?? undefined, height: height ?? undefined, fit, withoutEnlargement: false });
    let outFormat: string;
    if (format === "jpg" || format === "jpeg") { pipeline = pipeline.jpeg({ quality }); outFormat = "jpg"; }
    else if (format === "webp") { pipeline = pipeline.webp({ quality }); outFormat = "webp"; }
    else if (format === "avif") { pipeline = pipeline.avif({ quality }); outFormat = "avif"; }
    else if (format === "png") { pipeline = pipeline.png(); outFormat = "png"; }
    else {
      const ext = (ref.filename ?? "").split(".").pop()?.toLowerCase() ?? "png";
      outFormat = ext === "jpeg" ? "jpg" : ext;
    }
    const out = await pipeline.toBuffer();
    const baseName = (ref.filename ?? ref.ref).replace(/\.[^.]+$/, "");
    const outRef = `${baseName}-resized.${outFormat}`;
    const outPath = join(ctx.scratchDir, outRef);
    await writeFile(outPath, out);
    const mime = outFormat === "jpg" ? "image/jpeg" : `image/${outFormat}`;
    fileRefs.push({ ref: outRef, bytes: out.length, sha256: "", mime, filename: outRef });
  }
  ctx.emitProgress(totalIn);

  return {
    ok: true,
    outputs: { resizedCount: fileRefs.length, fit, width, height, format: format ?? "preserved" },
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
