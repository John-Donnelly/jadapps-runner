/**
 * zip-to-7z: converts a ZIP into a 7z archive. 7z requires a native
 * driver (7z executable) and is reported as driver_missing when not
 * available — there is no pure-JS 7z encoder.
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

export default async function zipTo7z(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "zip-to-7z requires one ZIP input");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  if (buf[0] !== 0x50 || buf[1] !== 0x4b) {
    return errorResult("not_a_zip", "input is not a ZIP file");
  }
  ctx.emitProgress(totalIn);

  return errorResult(
    "driver_missing",
    "7z conversion requires the native 7z binary (p7zip or 7-Zip). No pure-JS 7z encoder is available.",
  );
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
