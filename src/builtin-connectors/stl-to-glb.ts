/**
 * stl-to-glb: converts STL to glTF binary (GLB). Requires a glTF
 * encoder — reports driver_missing.
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

export default async function stlToGlb(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "stl-to-glb requires one STL input");
  const inPath = join(ctx.scratchDir, ref.ref);
  await readFile(inPath);
  ctx.emitProgress(sizeOrFallback(inPath, ref.bytes));
  void start;
  return errorResult("driver_missing", "STL-to-GLB conversion requires a glTF encoder (e.g. @gltf-transform/core or three.js GLTFExporter).");
}

function sizeOrFallback(path: string, fallback: number): number { try { return statSync(path).size; } catch { return fallback; } }
function errorResult(code: string, message: string): StepResult { return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } }; }
