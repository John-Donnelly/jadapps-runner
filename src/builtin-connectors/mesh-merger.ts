/**
 * mesh-merger: combines multiple STLs into a single STL.
 */

import { readFile, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { join } from "node:path";
import type { StepResult, FileRef } from "../types.js";
import { parseStl, writeBinaryStl, type Triangle } from "./_stl-utils.js";

interface ToolContext {
  toolId: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRef[];
  scratchDir: string;
  emitProgress(bytes: number): void;
}

export default async function meshMerger(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  if (ctx.fileRefs.length < 2) return errorResult("missing_input", "mesh-merger requires at least two STL inputs");
  let totalIn = 0;
  const merged: Triangle[] = [];
  for (const ref of ctx.fileRefs) {
    const path = join(ctx.scratchDir, ref.ref);
    totalIn += sizeOrFallback(path, ref.bytes);
    const buf = await readFile(path);
    merged.push(...parseStl(buf));
  }
  ctx.emitProgress(totalIn);
  const out = writeBinaryStl(merged);
  const outRef = "merged.stl";
  await writeFile(join(ctx.scratchDir, outRef), out);
  return { ok: true, outputs: { meshCount: ctx.fileRefs.length, totalTriangles: merged.length }, fileRefs: [{ ref: outRef, bytes: out.length, sha256: "", mime: "model/stl", filename: outRef }], bytesProcessed: totalIn, durationMs: Date.now() - start };
}

function sizeOrFallback(path: string, fallback: number): number { try { return statSync(path).size; } catch { return fallback; } }
function errorResult(code: string, message: string): StepResult { return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } }; }
