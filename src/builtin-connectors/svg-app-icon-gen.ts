/**
 * svg-app-icon-gen: emits a multi-size app icon set from a single SVG.
 * Generates PNGs at iOS/Android/desktop resolutions plus an Apple Touch
 * Icon and an .ico-friendly 256×256.
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

const DEFAULT_SIZES = [16, 32, 48, 64, 96, 128, 180, 192, 256, 512, 1024];

export default async function svgAppIconGen(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "svg-app-icon-gen requires one SVG input");
  const cfg = ctx.inputs ?? {};
  const sizes = Array.isArray(cfg.sizes) ? cfg.sizes.map(Number).filter((n) => n > 0 && n <= 4096) : DEFAULT_SIZES;
  const background = String(cfg.background ?? "transparent");

  let sharpMod: typeof import("sharp");
  try { sharpMod = (await import("sharp")).default as unknown as typeof import("sharp"); }
  catch (err) { return errorResult("driver_missing", `sharp not installed: ${(err as Error).message}`); }
  const sharp = sharpMod as unknown as (input: Buffer, options?: { density?: number }) => import("sharp").Sharp;

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);

  const fileRefs: FileRef[] = [];
  for (const size of sizes) {
    let pipeline = sharp(buf, { density: 384 }).resize({ width: size, height: size, fit: "contain", background: background === "transparent" ? { r: 0, g: 0, b: 0, alpha: 0 } : background });
    if (background !== "transparent") pipeline = pipeline.flatten({ background });
    const out = await pipeline.png().toBuffer();
    const outRef = `icon-${size}.png`;
    const outPath = join(ctx.scratchDir, outRef);
    await writeFile(outPath, out);
    fileRefs.push({ ref: outRef, bytes: out.length, sha256: "", mime: "image/png", filename: outRef });
  }

  return {
    ok: true,
    outputs: { sizes },
    fileRefs,
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
