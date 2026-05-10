/**
 * png-to-avif: re-encodes PNG as AVIF.
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

export default async function pngToAvif(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "png-to-avif requires one PNG input");
  let sharp: typeof import("sharp");
  try { sharp = (await import("sharp")).default as unknown as typeof import("sharp"); }
  catch (err) { return errorResult("driver_missing", `sharp not installed: ${(err as Error).message}`); }
  const cfg = ctx.inputs ?? {};
  const quality = Math.max(1, Math.min(100, Number(cfg.quality ?? 60)));
  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);
  const out = await (sharp as unknown as (b: Buffer) => { avif(o: { quality: number }): { toBuffer(): Promise<Buffer> } })(buf).avif({ quality }).toBuffer();
  const outRef = (ref.filename ?? ref.ref).replace(/\.png$/i, ".avif");
  await writeFile(join(ctx.scratchDir, outRef), out);
  return { ok: true, outputs: { inputBytes: buf.length, outputBytes: out.length, quality, savedBytes: buf.length - out.length }, fileRefs: [{ ref: outRef, bytes: out.length, sha256: "", mime: "image/avif", filename: outRef }], bytesProcessed: totalIn, durationMs: Date.now() - start };
}

function sizeOrFallback(path: string, fallback: number): number { try { return statSync(path).size; } catch { return fallback; } }
function errorResult(code: string, message: string): StepResult { return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } }; }
