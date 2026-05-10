/**
 * mesh-decimator: reduces triangle count by random sampling (cheap
 * approximation of edge-collapse decimation, which would need a proper
 * library like meshoptimizer).
 */

import { readFile, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { join } from "node:path";
import type { StepResult, FileRef } from "../types.js";
import { parseStl, writeBinaryStl } from "./_stl-utils.js";

interface ToolContext {
  toolId: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRef[];
  scratchDir: string;
  emitProgress(bytes: number): void;
}

export default async function meshDecimator(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "mesh-decimator requires one STL input");
  const cfg = ctx.inputs ?? {};
  const target = Math.max(0.05, Math.min(1, Number(cfg.targetRatio ?? 0.5)));
  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);
  const tris = parseStl(buf);
  const targetCount = Math.max(4, Math.floor(tris.length * target));
  const step = tris.length / targetCount;
  const kept: typeof tris = [];
  for (let i = 0; i < targetCount; i++) {
    const idx = Math.min(tris.length - 1, Math.floor(i * step));
    kept.push(tris[idx]!);
  }
  const out = writeBinaryStl(kept);
  const outRef = (ref.filename ?? ref.ref).replace(/\.stl$/i, ".decimated.stl");
  await writeFile(join(ctx.scratchDir, outRef), out);
  return { ok: true, outputs: { originalCount: tris.length, keptCount: kept.length, targetRatio: target }, fileRefs: [{ ref: outRef, bytes: out.length, sha256: "", mime: "model/stl", filename: outRef }], bytesProcessed: totalIn, durationMs: Date.now() - start };
}

function sizeOrFallback(path: string, fallback: number): number { try { return statSync(path).size; } catch { return fallback; } }
function errorResult(code: string, message: string): StepResult { return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } }; }
