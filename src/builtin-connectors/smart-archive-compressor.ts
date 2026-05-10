/**
 * smart-archive-compressor: classifies each input by extension into
 * "already compressed" (jpg, png, mp4, zip, gz, etc.) vs "compressible"
 * and stores the former at level 0 (STORE) and the latter at level 9.
 * Avoids wasted CPU on data that won't shrink.
 */

import { readFile, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { join, extname } from "node:path";
import type { StepResult, FileRef } from "../types.js";

interface ToolContext {
  toolId: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRef[];
  scratchDir: string;
  emitProgress(bytes: number): void;
}

const STORED_EXTS = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".avif",
  ".mp4", ".mkv", ".mov", ".webm", ".avi",
  ".mp3", ".aac", ".ogg", ".flac", ".m4a",
  ".zip", ".gz", ".7z", ".rar", ".bz2", ".xz", ".tgz",
  ".pdf",
]);

export default async function smartArchiveCompressor(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  if (!Array.isArray(ctx.fileRefs) || ctx.fileRefs.length === 0) {
    return errorResult("missing_input", "smart-archive-compressor requires at least one input");
  }

  let JSZip: typeof import("jszip");
  try { JSZip = (await import("jszip")).default as unknown as typeof import("jszip"); }
  catch (err) { return errorResult("driver_missing", `jszip not installed: ${(err as Error).message}`); }

  const zip = new (JSZip as unknown as new () => import("jszip"))();
  let totalIn = 0;
  let stored = 0;
  let deflated = 0;
  for (const ref of ctx.fileRefs) {
    const path = join(ctx.scratchDir, ref.ref);
    totalIn += sizeOrFallback(path, ref.bytes);
    const data = await readFile(path);
    const ext = extname(ref.filename ?? ref.ref).toLowerCase();
    const isStored = STORED_EXTS.has(ext);
    zip.file(ref.filename ?? ref.ref, data, isStored
      ? { compression: "STORE" }
      : { compression: "DEFLATE", compressionOptions: { level: 9 } });
    if (isStored) stored += 1; else deflated += 1;
  }
  ctx.emitProgress(totalIn);

  const out = await zip.generateAsync({ type: "nodebuffer" });
  const outRef = "smart-archive.zip";
  await writeFile(join(ctx.scratchDir, outRef), out);

  return {
    ok: true,
    outputs: { stored, deflated, inputBytes: totalIn, outputBytes: out.length },
    fileRefs: [{ ref: outRef, bytes: out.length, sha256: "", mime: "application/zip", filename: outRef }],
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
