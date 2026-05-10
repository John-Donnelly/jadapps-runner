/**
 * obj-to-usdz: USDZ is Apple's zipped USD format — building one
 * requires the USD library (Pixar) or `usdz_converter` from Xcode.
 * Reports driver_missing in the runner.
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

export default async function objToUsdz(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "obj-to-usdz requires one OBJ input");
  const inPath = join(ctx.scratchDir, ref.ref);
  await readFile(inPath);
  ctx.emitProgress(sizeOrFallback(inPath, ref.bytes));
  void start;
  return errorResult("driver_missing", "OBJ-to-USDZ conversion requires Pixar's USD library or Apple's usdz_converter (macOS-only). The runner does not bundle these.");
}

function sizeOrFallback(path: string, fallback: number): number { try { return statSync(path).size; } catch { return fallback; } }
function errorResult(code: string, message: string): StepResult { return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } }; }
