/**
 * variable-font-freezer: instances a variable font at fixed axis values,
 * producing a static font. Requires hb-subset / fontTools instancer to
 * actually rewrite the font tables — reports driver_missing.
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

export default async function variableFontFreezer(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "variable-font-freezer requires one variable font input");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  await readFile(inPath);
  ctx.emitProgress(totalIn);
  void start;

  return errorResult(
    "driver_missing",
    "Freezing variable-font axes to a static instance requires hb-subset or fontTools varLib.instancer (Python). The runner does not bundle these.",
  );
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
