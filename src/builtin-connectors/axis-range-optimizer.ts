/**
 * axis-range-optimizer: for a variable font, suggests narrower axis
 * ranges that still cover all required uses, based on the user's
 * requested axis bounds. Produces an analysis JSON; actual axis
 * pinning needs hb-subset (driver_missing).
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

export default async function axisRangeOptimizer(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "axis-range-optimizer requires one variable font input");

  let fontkit: unknown;
  try {
    const fontkitMod = await import("@pdf-lib/fontkit");
    fontkit = (fontkitMod as unknown as { default?: unknown }).default ?? fontkitMod;
  } catch (err) {
    return errorResult("driver_missing", `@pdf-lib/fontkit not installed: ${(err as Error).message}`);
  }

  const cfg = ctx.inputs ?? {};
  const requested = (cfg.requestedAxes ?? {}) as Record<string, { min?: number; max?: number }>;

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);

  const font = (fontkit as { create(b: Buffer): { variationAxes?: Record<string, { name: string; min: number; max: number; default: number }> } }).create(buf);
  const axes = font.variationAxes ?? {};

  const recs: { axis: string; original: { min: number; max: number; default: number }; suggested: { min: number; max: number } }[] = [];
  for (const [tag, info] of Object.entries(axes)) {
    const req = requested[tag] ?? {};
    const minNorm = Math.max(info.min, req.min ?? info.min);
    const maxNorm = Math.min(info.max, req.max ?? info.max);
    recs.push({
      axis: tag,
      original: { min: info.min, max: info.max, default: info.default },
      suggested: { min: minNorm, max: maxNorm },
    });
  }

  const out = JSON.stringify({ file: ref.filename ?? ref.ref, axisCount: recs.length, recommendations: recs }, null, 2);
  const outRef = "axis-range-recs.json";
  await writeFile(join(ctx.scratchDir, outRef), out, "utf8");

  return {
    ok: true,
    outputs: { axisCount: recs.length, isVariableFont: recs.length > 0 },
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
