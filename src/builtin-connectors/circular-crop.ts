/**
 * circular-crop: masks an image to a circle (with transparent corners),
 * outputting PNG to preserve alpha. Useful for avatars.
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

export default async function circularCrop(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "circular-crop requires one image input");
  let sharp: typeof import("sharp");
  try { sharp = (await import("sharp")).default as unknown as typeof import("sharp"); }
  catch (err) { return errorResult("driver_missing", `sharp not installed: ${(err as Error).message}`); }
  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);
  const factory = sharp as unknown as (b: Buffer | object) => {
    metadata(): Promise<{ width?: number; height?: number }>;
    extract(o: { left: number; top: number; width: number; height: number }): { composite(c: { input: Buffer; blend: string }[]): { png(): { toBuffer(): Promise<Buffer> } } };
  };
  const meta = await factory(buf).metadata();
  const size = Math.min(meta.width ?? 256, meta.height ?? 256);
  const left = Math.round(((meta.width ?? size) - size) / 2);
  const top = Math.round(((meta.height ?? size) - size) / 2);
  const mask = Buffer.from(`<svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="white"/></svg>`);
  const out = await factory(buf).extract({ left, top, width: size, height: size }).composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();
  const outRef = (ref.filename ?? ref.ref).replace(/(\.[^.]+)?$/, ".circle.png");
  await writeFile(join(ctx.scratchDir, outRef), out);
  return { ok: true, outputs: { size, inputBytes: buf.length, outputBytes: out.length }, fileRefs: [{ ref: outRef, bytes: out.length, sha256: "", mime: "image/png", filename: outRef }], bytesProcessed: totalIn, durationMs: Date.now() - start };
}

function sizeOrFallback(path: string, fallback: number): number { try { return statSync(path).size; } catch { return fallback; } }
function errorResult(code: string, message: string): StepResult { return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } }; }
