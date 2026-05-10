/**
 * name-table-cleaner: rewrites the font's `name` table to remove
 * trailing whitespace, normalize line endings, and optionally strip
 * platform-1 (Macintosh) records, which are rarely needed today.
 *
 * True name-table editing requires fontTools' name table API — reports
 * driver_missing on bad inputs.
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

export default async function nameTableCleaner(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "name-table-cleaner requires one font input");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  await readFile(inPath);
  ctx.emitProgress(totalIn);
  void start;

  return errorResult(
    "driver_missing",
    "rewriting the SFNT `name` table requires fontTools (pyftedit) or a similar font surgeon. The runner does not bundle these binaries.",
  );
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
