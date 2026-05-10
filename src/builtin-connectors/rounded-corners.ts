/**
 * rounded-corners: applies an SVG rounded-rectangle mask to an image,
 * outputting PNG to preserve corner transparency.
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

export default async function roundedCorners(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "rounded-corners requires one image input");
  let sharp: typeof import("sharp");
  try { sharp = (await import("sharp")).default as unknown as typeof import("sharp"); }
  catch (err) { return errorResult("driver_missing", `sharp not installed: ${(err as Error).message}`); }
  const cfg = ctx.inputs ?? {};
  const radius = Math.max(0, Number(cfg.radius ?? 16));
  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);
  const factory = sharp as unknown as (b: Buffer) => {
    metadata(): Promise<{ width?: number; height?: number }>;
    composite(c: { input: Buffer; blend: string }[]): { png(): { toBuffer(): Promise<Buffer> } };
  };
  const meta = await factory(buf).metadata();
  const w = meta.width ?? 256;
  const h = meta.height ?? 256;
  const mask = Buffer.from(`<svg width="${w}" height="${h}"><rect x="0" y="0" width="${w}" height="${h}" rx="${radius}" ry="${radius}" fill="white"/></svg>`);
  const out = await factory(buf).composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();
  const outRef = (ref.filename ?? ref.ref).replace(/(\.[^.]+)?$/, ".rounded.png");
  await writeFile(join(ctx.scratchDir, outRef), out);
  return { ok: true, outputs: { radius, width: w, height: h, inputBytes: buf.length, outputBytes: out.length }, fileRefs: [{ ref: outRef, bytes: out.length, sha256: "", mime: "image/png", filename: outRef }], bytesProcessed: totalIn, durationMs: Date.now() - start };
}

function sizeOrFallback(path: string, fallback: number): number { try { return statSync(path).size; } catch { return fallback; } }
function errorResult(code: string, message: string): StepResult { return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } }; }
