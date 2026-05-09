/**
 * svg-canvas-exporter: rasterises an SVG to PNG (or JPG/WebP) at a
 * configurable density via sharp. Sharp has its own SVG renderer (librsvg
 * under the hood) — quality is high for typical iconography.
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

export default async function svgCanvasExporter(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "svg-canvas-exporter requires one SVG input");
  const cfg = ctx.inputs ?? {};
  const width = cfg.width != null ? Math.max(8, Math.min(8192, Math.floor(Number(cfg.width)))) : null;
  const density = Math.max(72, Math.min(600, Math.floor(Number(cfg.density ?? 144))));
  const format = ["png", "jpg", "jpeg", "webp"].includes(cfg.format as string) ? cfg.format as "png" | "jpg" | "jpeg" | "webp" : "png";
  const quality = Math.max(1, Math.min(100, Math.floor(Number(cfg.quality ?? 90))));

  let sharpMod: typeof import("sharp");
  try { sharpMod = (await import("sharp")).default as unknown as typeof import("sharp"); }
  catch (err) { return errorResult("driver_missing", `sharp not installed: ${(err as Error).message}`); }
  const sharp = sharpMod as unknown as (input: Buffer, options?: { density?: number }) => import("sharp").Sharp;

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);

  let pipeline = sharp(buf, { density });
  if (width != null) pipeline = pipeline.resize({ width });
  let out: Buffer;
  let outFormat: string;
  if (format === "jpg" || format === "jpeg") { out = await pipeline.flatten({ background: "white" }).jpeg({ quality }).toBuffer(); outFormat = "jpg"; }
  else if (format === "webp") { out = await pipeline.webp({ quality }).toBuffer(); outFormat = "webp"; }
  else { out = await pipeline.png().toBuffer(); outFormat = "png"; }

  const baseName = (ref.filename ?? "image.svg").replace(/\.svg$/i, "");
  const outRef = `${baseName}.${outFormat}`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, out);

  const mime = outFormat === "jpg" ? "image/jpeg" : `image/${outFormat}`;
  return {
    ok: true,
    outputs: { format: outFormat, density, width },
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
