/**
 * heic-to-jpg: converts HEIC/HEIF (iPhone) photos to JPEG. sharp's
 * HEIF support is build-flag dependent; reports driver_missing if
 * sharp was compiled without libheif.
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

export default async function heicToJpg(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "heic-to-jpg requires one HEIC/HEIF input");

  let sharp: typeof import("sharp");
  try { sharp = (await import("sharp")).default as unknown as typeof import("sharp"); }
  catch (err) { return errorResult("driver_missing", `sharp not installed: ${(err as Error).message}`); }

  const cfg = ctx.inputs ?? {};
  const quality = clamp(Number(cfg.quality ?? 85), 1, 100);

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);

  let out: Buffer;
  try {
    out = await (sharp as unknown as (b: Buffer) => { jpeg(opts: { quality: number }): { toBuffer(): Promise<Buffer> } })(buf).jpeg({ quality }).toBuffer();
  } catch (err) {
    return errorResult("driver_missing", `sharp build does not support HEIC: ${(err as Error).message}. Rebuild sharp with libheif support.`);
  }

  const outRef = (ref.filename ?? ref.ref).replace(/\.(heic|heif)$/i, ".jpg");
  await writeFile(join(ctx.scratchDir, outRef), out);
  return {
    ok: true,
    outputs: { inputBytes: buf.length, outputBytes: out.length, quality },
    fileRefs: [{ ref: outRef, bytes: out.length, sha256: "", mime: "image/jpeg", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
