/**
 * image-flipper: flips an image horizontally and/or vertically.
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

export default async function imageFlipper(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "image-flipper requires one image input");
  let sharp: typeof import("sharp");
  try { sharp = (await import("sharp")).default as unknown as typeof import("sharp"); }
  catch (err) { return errorResult("driver_missing", `sharp not installed: ${(err as Error).message}`); }
  const cfg = ctx.inputs ?? {};
  const horizontal = Boolean(cfg.horizontal ?? true);
  const vertical = Boolean(cfg.vertical ?? false);
  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);
  let pipe = (sharp as unknown as (b: Buffer) => { flip(): unknown; flop(): unknown; toBuffer(): Promise<Buffer> })(buf);
  if (vertical) pipe = pipe.flip() as typeof pipe;
  if (horizontal) pipe = pipe.flop() as typeof pipe;
  const out = await pipe.toBuffer();
  const outRef = (ref.filename ?? ref.ref).replace(/(\.[^.]+)$/, ".flipped$1");
  await writeFile(join(ctx.scratchDir, outRef), out);
  return { ok: true, outputs: { horizontal, vertical, inputBytes: buf.length, outputBytes: out.length }, fileRefs: [{ ref: outRef, bytes: out.length, sha256: "", mime: ref.mime, filename: outRef }], bytesProcessed: totalIn, durationMs: Date.now() - start };
}

function sizeOrFallback(path: string, fallback: number): number { try { return statSync(path).size; } catch { return fallback; } }
function errorResult(code: string, message: string): StepResult { return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } }; }
