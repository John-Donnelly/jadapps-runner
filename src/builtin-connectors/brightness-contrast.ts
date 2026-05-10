/**
 * brightness-contrast: adjusts brightness (multiplier) and contrast
 * (linear) of an image. Brightness 1.0 = unchanged, 1.5 = 50% brighter.
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

export default async function brightnessContrast(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "brightness-contrast requires one image input");
  let sharp: typeof import("sharp");
  try { sharp = (await import("sharp")).default as unknown as typeof import("sharp"); }
  catch (err) { return errorResult("driver_missing", `sharp not installed: ${(err as Error).message}`); }
  const cfg = ctx.inputs ?? {};
  const brightness = Math.max(0.1, Math.min(10, Number(cfg.brightness ?? 1)));
  const contrast = Math.max(-100, Math.min(100, Number(cfg.contrast ?? 0)));
  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);
  const a = 1 + contrast / 100;
  const b = -(contrast / 100) * 128;
  const out = await (sharp as unknown as (b: Buffer) => { modulate(o: { brightness: number }): { linear(a: number, b: number): { toBuffer(): Promise<Buffer> } } })(buf).modulate({ brightness }).linear(a, b).toBuffer();
  const outRef = (ref.filename ?? ref.ref).replace(/(\.[^.]+)$/, ".bc$1");
  await writeFile(join(ctx.scratchDir, outRef), out);
  return { ok: true, outputs: { brightness, contrast, inputBytes: buf.length, outputBytes: out.length }, fileRefs: [{ ref: outRef, bytes: out.length, sha256: "", mime: ref.mime, filename: outRef }], bytesProcessed: totalIn, durationMs: Date.now() - start };
}

function sizeOrFallback(path: string, fallback: number): number { try { return statSync(path).size; } catch { return fallback; } }
function errorResult(code: string, message: string): StepResult { return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } }; }
