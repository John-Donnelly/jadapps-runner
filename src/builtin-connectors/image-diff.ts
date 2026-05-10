/**
 * image-diff: pixel-level diff between two same-dimension images.
 * Outputs a delta image and a difference percentage.
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

export default async function imageDiff(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  if (ctx.fileRefs.length < 2) return errorResult("missing_input", "image-diff requires two image inputs");
  const refA = ctx.fileRefs[0]!;
  const refB = ctx.fileRefs[1]!;
  let sharp: typeof import("sharp");
  try { sharp = (await import("sharp")).default as unknown as typeof import("sharp"); }
  catch (err) { return errorResult("driver_missing", `sharp not installed: ${(err as Error).message}`); }

  const aPath = join(ctx.scratchDir, refA.ref);
  const bPath = join(ctx.scratchDir, refB.ref);
  const totalIn = sizeOrFallback(aPath, refA.bytes) + sizeOrFallback(bPath, refB.bytes);
  const aBuf = await readFile(aPath);
  const bBuf = await readFile(bPath);
  ctx.emitProgress(totalIn);
  const factory = sharp as unknown as (b: Buffer | object) => {
    metadata(): Promise<{ width?: number; height?: number }>;
    raw(): { toBuffer(o: { resolveWithObject: boolean }): Promise<{ data: Buffer; info: { width: number; height: number; channels: number } }> };
    png(): { toBuffer(): Promise<Buffer> };
    resize(w: number, h: number): { raw(): { toBuffer(o: { resolveWithObject: boolean }): Promise<{ data: Buffer; info: { width: number; height: number; channels: number } }> } };
  };

  const aRaw = await factory(aBuf).raw().toBuffer({ resolveWithObject: true });
  const bResized = await factory(bBuf).resize(aRaw.info.width, aRaw.info.height).raw().toBuffer({ resolveWithObject: true });
  const diff = Buffer.alloc(aRaw.data.length);
  let differingPixels = 0;
  const channels = aRaw.info.channels;
  for (let i = 0; i < aRaw.data.length; i += channels) {
    const dr = Math.abs((aRaw.data[i] ?? 0) - (bResized.data[i] ?? 0));
    const dg = Math.abs((aRaw.data[i + 1] ?? 0) - (bResized.data[i + 1] ?? 0));
    const db = Math.abs((aRaw.data[i + 2] ?? 0) - (bResized.data[i + 2] ?? 0));
    diff[i] = Math.min(255, dr * 4);
    diff[i + 1] = Math.min(255, dg * 4);
    diff[i + 2] = Math.min(255, db * 4);
    if (channels === 4) diff[i + 3] = 255;
    if (dr + dg + db > 12) differingPixels += 1;
  }

  const out = await factory({ raw: { width: aRaw.info.width, height: aRaw.info.height, channels: aRaw.info.channels }, create: undefined } as unknown as object as object).png().toBuffer().catch(() => factory(diff).png().toBuffer());
  // Fallback path: rebuild via sharp directly from raw
  const factory2 = sharp as unknown as (b: Buffer, o: { raw: { width: number; height: number; channels: number } }) => { png(): { toBuffer(): Promise<Buffer> } };
  const diffPng = await factory2(diff, { raw: { width: aRaw.info.width, height: aRaw.info.height, channels: aRaw.info.channels } }).png().toBuffer();

  const totalPixels = aRaw.info.width * aRaw.info.height;
  const diffPercent = (differingPixels / totalPixels) * 100;
  const outRef = "image-diff.png";
  await writeFile(join(ctx.scratchDir, outRef), diffPng);
  void out;
  return { ok: true, outputs: { width: aRaw.info.width, height: aRaw.info.height, differingPixels, diffPercent }, fileRefs: [{ ref: outRef, bytes: diffPng.length, sha256: "", mime: "image/png", filename: outRef }], bytesProcessed: totalIn, durationMs: Date.now() - start };
}

function sizeOrFallback(path: string, fallback: number): number { try { return statSync(path).size; } catch { return fallback; } }
function errorResult(code: string, message: string): StepResult { return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } }; }
