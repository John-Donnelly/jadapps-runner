/**
 * layer-slicer: full slicer (CuraEngine, PrusaSlicer) is way out of
 * scope for an in-process runner — reports driver_missing.
 */

import { readFile } from "node:fs/promises";
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

export default async function layerSlicer(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "layer-slicer requires one STL input");
  const inPath = join(ctx.scratchDir, ref.ref);
  await readFile(inPath);
  ctx.emitProgress(sizeOrFallback(inPath, ref.bytes));
  void start;
  return errorResult("driver_missing", "layer slicing requires a real slicer (CuraEngine, PrusaSlicer, BambuStudio). The runner does not bundle these binaries.");
}

function sizeOrFallback(path: string, fallback: number): number { try { return statSync(path).size; } catch { return fallback; } }
function errorResult(code: string, message: string): StepResult { return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } }; }
