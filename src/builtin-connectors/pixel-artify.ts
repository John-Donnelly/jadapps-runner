/**
 * pixel-artify: downsamples then upsamples (nearest-neighbour) to give
 * the input image a chunky pixel-art look.
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

export default async function pixelArtify(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "pixel-artify requires one image input");
  let sharp: typeof import("sharp");
  try { sharp = (await import("sharp")).default as unknown as typeof import("sharp"); }
  catch (err) { return errorResult("driver_missing", `sharp not installed: ${(err as Error).message}`); }
  const cfg = ctx.inputs ?? {};
  const blockSize = Math.max(2, Math.min(64, Number(cfg.blockSize ?? 8)));
  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);
  const factory = sharp as unknown as (b: Buffer) => {
    metadata(): Promise<{ width?: number; height?: number }>;
    resize(w: number, h: number, opts: object): { resize(w2: number, h2: number, opts2: object): { png(): { toBuffer(): Promise<Buffer> } } };
  };
  const meta = await factory(buf).metadata();
  const w = meta.width ?? 256;
  const h = meta.height ?? 256;
  const smallW = Math.max(1, Math.floor(w / blockSize));
  const smallH = Math.max(1, Math.floor(h / blockSize));
  const out = await factory(buf).resize(smallW, smallH, { kernel: "nearest" }).resize(w, h, { kernel: "nearest" }).png().toBuffer();
  const outRef = (ref.filename ?? ref.ref).replace(/(\.[^.]+)?$/, ".pixel.png");
  await writeFile(join(ctx.scratchDir, outRef), out);
  return { ok: true, outputs: { blockSize, originalSize: { w, h }, downsampledSize: { w: smallW, h: smallH } }, fileRefs: [{ ref: outRef, bytes: out.length, sha256: "", mime: "image/png", filename: outRef }], bytesProcessed: totalIn, durationMs: Date.now() - start };
}

function sizeOrFallback(path: string, fallback: number): number { try { return statSync(path).size; } catch { return fallback; } }
function errorResult(code: string, message: string): StepResult { return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } }; }
