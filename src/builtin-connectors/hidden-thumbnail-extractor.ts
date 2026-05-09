/**
 * hidden-thumbnail-extractor: many cameras and editing tools embed a small
 * preview JPEG inside the EXIF block. This pulls out that thumbnail (often
 * containing the un-cropped or pre-edit image, surfacing privacy issues).
 * Multiple inputs produce one thumbnail file per source image.
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

export default async function hiddenThumbnailExtractor(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  if (!Array.isArray(ctx.fileRefs) || ctx.fileRefs.length === 0) {
    return errorResult("missing_input", "hidden-thumbnail-extractor requires at least one image");
  }

  let exifr: typeof import("exifr");
  try { exifr = await import("exifr"); }
  catch (err) { return errorResult("driver_missing", `exifr not installed: ${(err as Error).message}`); }

  const fileRefs: FileRef[] = [];
  const extracted: { source: string; thumbnailRef: string; thumbnailBytes: number }[] = [];
  const skipped: { source: string; reason: string }[] = [];
  let totalIn = 0;

  for (const ref of ctx.fileRefs) {
    const path = join(ctx.scratchDir, ref.ref);
    totalIn += sizeOrFallback(path, ref.bytes);
    const buf = await readFile(path);
    let thumb: Uint8Array | undefined;
    try { thumb = await exifr.thumbnail(buf) as Uint8Array | undefined; }
    catch { skipped.push({ source: ref.filename, reason: "no embedded thumbnail" }); continue; }
    if (!thumb) { skipped.push({ source: ref.filename, reason: "no embedded thumbnail" }); continue; }
    const thumbBuf = Buffer.from(thumb.buffer, thumb.byteOffset, thumb.byteLength);
    const thumbName = `${(ref.filename ?? "image").replace(/\.[^.]+$/, "")}-thumb.jpg`;
    const thumbPath = join(ctx.scratchDir, thumbName);
    await writeFile(thumbPath, thumbBuf);
    fileRefs.push({ ref: thumbName, bytes: thumbBuf.length, sha256: "", mime: "image/jpeg", filename: thumbName });
    extracted.push({ source: ref.filename, thumbnailRef: thumbName, thumbnailBytes: thumbBuf.length });
  }
  ctx.emitProgress(totalIn);

  return {
    ok: true,
    outputs: { extractedCount: extracted.length, skipped, extracted },
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
