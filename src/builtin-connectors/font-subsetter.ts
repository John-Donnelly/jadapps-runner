/**
 * font-subsetter: subsets a font down to a specific Unicode range or
 * sample-text whitelist. True font subsetting requires the harfbuzz/
 * fontTools ecosystem; reports driver_missing if pure-JS fallback isn't
 * sufficient.
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

export default async function fontSubsetter(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "font-subsetter requires one font input");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  await readFile(inPath);
  ctx.emitProgress(totalIn);
  void start;

  return errorResult(
    "driver_missing",
    "font subsetting requires the harfbuzz / fonttools ecosystem (e.g. pyftsubset or hb-subset). The runner does not bundle these. Install fonttools locally or run in a build pipeline.",
  );
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
