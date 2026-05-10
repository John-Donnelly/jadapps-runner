/**
 * font-metrics-analyzer: extracts vertical metrics (ascent, descent,
 * line-gap, x-height, cap-height, units-per-em) from a font and
 * computes derived CSS-relevant ratios for layout work.
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

export default async function fontMetricsAnalyzer(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "font-metrics-analyzer requires one font input");

  let fontkit: unknown;
  try {
    const fontkitMod = await import("@pdf-lib/fontkit");
    fontkit = (fontkitMod as unknown as { default?: unknown }).default ?? fontkitMod;
  } catch (err) {
    return errorResult("driver_missing", `@pdf-lib/fontkit not installed: ${(err as Error).message}`);
  }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);

  const font = (fontkit as { create(b: Buffer): Record<string, number> }).create(buf);
  const upm = Number(font.unitsPerEm) || 1000;
  const ascent = Number(font.ascent) || 0;
  const descent = Number(font.descent) || 0;
  const lineGap = Number(font.lineGap) || 0;
  const xHeight = Number(font.xHeight) || 0;
  const capHeight = Number(font.capHeight) || 0;

  const metrics = {
    unitsPerEm: upm,
    ascent, descent, lineGap, xHeight, capHeight,
    lineHeight: ascent + Math.abs(descent) + lineGap,
    cssAscentRatio: ascent / upm,
    cssDescentRatio: Math.abs(descent) / upm,
    cssLineGapRatio: lineGap / upm,
    xHeightRatio: xHeight / upm,
    capHeightRatio: capHeight / upm,
  };
  const out = JSON.stringify({ file: ref.filename ?? ref.ref, metrics }, null, 2);
  const outRef = "font-metrics.json";
  await writeFile(join(ctx.scratchDir, outRef), out, "utf8");

  return {
    ok: true,
    outputs: { unitsPerEm: upm, ascent, descent, lineGap, xHeight, capHeight },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(out, "utf8"), sha256: "", mime: "application/json", filename: outRef }],
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
