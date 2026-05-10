/**
 * webp-to-jpg: re-encodes WebP as JPEG, configurable quality.
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

export default async function webpToJpg(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "webp-to-jpg requires one WebP input");
  let sharp: typeof import("sharp");
  try { sharp = (await import("sharp")).default as unknown as typeof import("sharp"); }
  catch (err) { return errorResult("driver_missing", `sharp not installed: ${(err as Error).message}`); }
  const cfg = ctx.inputs ?? {};
  const quality = Math.max(1, Math.min(100, Number(cfg.quality ?? 90)));
  const background = String(cfg.background ?? "#ffffff");
  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);
  const out = await (sharp as unknown as (b: Buffer) => { flatten(o: { background: string }): { jpeg(o: { quality: number }): { toBuffer(): Promise<Buffer> } } })(buf).flatten({ background }).jpeg({ quality }).toBuffer();
  const outRef = (ref.filename ?? ref.ref).replace(/\.webp$/i, ".jpg");
  await writeFile(join(ctx.scratchDir, outRef), out);
  return { ok: true, outputs: { inputBytes: buf.length, outputBytes: out.length, quality }, fileRefs: [{ ref: outRef, bytes: out.length, sha256: "", mime: "image/jpeg", filename: outRef }], bytesProcessed: totalIn, durationMs: Date.now() - start };
}

function sizeOrFallback(path: string, fallback: number): number { try { return statSync(path).size; } catch { return fallback; } }
function errorResult(code: string, message: string): StepResult { return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } }; }
