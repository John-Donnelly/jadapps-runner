/**
 * model-scaler: scales an STL uniformly or per-axis.
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

export default async function modelScaler(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "model-scaler requires one STL input");
  const cfg = ctx.inputs ?? {};
  const sx = Number(cfg.scaleX ?? cfg.scale ?? 1);
  const sy = Number(cfg.scaleY ?? cfg.scale ?? 1);
  const sz = Number(cfg.scaleZ ?? cfg.scale ?? 1);
  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);
  const tris = parseStl(buf).map((t) => ({
    nx: t.nx, ny: t.ny, nz: t.nz,
    v: t.v.map(([x, y, z]) => [x * sx, y * sy, z * sz]) as [number, number, number][],
  }));
  const out = writeBinaryStl(tris);
  const outRef = (ref.filename ?? ref.ref).replace(/\.stl$/i, ".scaled.stl");
  await writeFile(join(ctx.scratchDir, outRef), out);
  return { ok: true, outputs: { scaleX: sx, scaleY: sy, scaleZ: sz, triangleCount: tris.length }, fileRefs: [{ ref: outRef, bytes: out.length, sha256: "", mime: "model/stl", filename: outRef }], bytesProcessed: totalIn, durationMs: Date.now() - start };
}

function sizeOrFallback(path: string, fallback: number): number { try { return statSync(path).size; } catch { return fallback; } }
function errorResult(code: string, message: string): StepResult { return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } }; }
