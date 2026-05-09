/**
 * background-remover: removes the background from each input image, leaving
 * the foreground subject on a transparent canvas. Uses
 * @imgly/background-removal-node, which loads an ONNX U2-Net derivative the
 * first time it runs and caches it on disk thereafter.
 *
 * Output is always PNG (transparency support). Pass `format: "jpg"` and
 * `background` (hex color) to flatten to a coloured background instead.
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

export default async function backgroundRemover(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  if (!Array.isArray(ctx.fileRefs) || ctx.fileRefs.length === 0) {
    return errorResult("missing_input", "background-remover requires at least one image");
  }

  const cfg = ctx.inputs ?? {};
  const flattenColor = typeof cfg.background === "string" && cfg.background ? String(cfg.background) : null;
  const requestedFormat = ["png", "jpg", "jpeg", "webp"].includes(cfg.format as string) ? cfg.format as string : "png";

  let removerMod: typeof import("@imgly/background-removal-node");
  let sharpMod: typeof import("sharp");
  try { removerMod = await import("@imgly/background-removal-node"); }
  catch (err) { return errorResult("driver_missing", `@imgly/background-removal-node not installed: ${(err as Error).message}`); }
  try { sharpMod = (await import("sharp")).default as unknown as typeof import("sharp"); }
  catch (err) { return errorResult("driver_missing", `sharp not installed: ${(err as Error).message}`); }
  const sharp = sharpMod as unknown as (input?: Buffer) => import("sharp").Sharp;

  const fileRefs: FileRef[] = [];
  let totalIn = 0;
  for (const ref of ctx.fileRefs) {
    const path = join(ctx.scratchDir, ref.ref);
    totalIn += sizeOrFallback(path, ref.bytes);
    const buf = await readFile(path);
    const blob = new Blob([buf]);
    const result = await removerMod.removeBackground(blob);
    const cutoutPng = Buffer.from(await result.arrayBuffer());

    let outBuffer: Buffer;
    let outFormat: string;
    if (flattenColor && (requestedFormat === "jpg" || requestedFormat === "jpeg")) {
      outBuffer = await sharp(cutoutPng).flatten({ background: flattenColor }).jpeg({ quality: 92 }).toBuffer();
      outFormat = "jpg";
    } else if (requestedFormat === "webp") {
      outBuffer = await sharp(cutoutPng).webp({ quality: 92 }).toBuffer();
      outFormat = "webp";
    } else if (requestedFormat === "jpg" || requestedFormat === "jpeg") {
      outBuffer = await sharp(cutoutPng).flatten({ background: "white" }).jpeg({ quality: 92 }).toBuffer();
      outFormat = "jpg";
    } else {
      outBuffer = cutoutPng;
      outFormat = "png";
    }

    const baseName = (ref.filename ?? ref.ref).replace(/\.[^.]+$/, "");
    const outRef = `${baseName}-cutout.${outFormat}`;
    const outPath = join(ctx.scratchDir, outRef);
    await writeFile(outPath, outBuffer);
    const mime = outFormat === "jpg" ? "image/jpeg" : `image/${outFormat}`;
    fileRefs.push({ ref: outRef, bytes: outBuffer.length, sha256: "", mime, filename: outRef });
  }
  ctx.emitProgress(totalIn);

  return {
    ok: true,
    outputs: { processedCount: fileRefs.length, format: requestedFormat, flatten: flattenColor != null },
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
