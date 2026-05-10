/**
 * glb-to-obj: converts a glTF binary (GLB) to OBJ. Requires a glTF
 * loader to walk the binary buffer + accessor scheme — reports
 * driver_missing.
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

export default async function glbToObj(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "glb-to-obj requires one GLB input");
  const inPath = join(ctx.scratchDir, ref.ref);
  await readFile(inPath);
  ctx.emitProgress(sizeOrFallback(inPath, ref.bytes));
  void start;
  return errorResult("driver_missing", "GLB-to-OBJ conversion requires a glTF loader (e.g. @gltf-transform/core or three.js GLTFLoader).");
}

function sizeOrFallback(path: string, fallback: number): number { try { return statSync(path).size; } catch { return fallback; } }
function errorResult(code: string, message: string): StepResult { return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } }; }
