/**
 * stl-repair: removes degenerate triangles (zero area or NaN coords)
 * and recomputes all normals. Best-effort cleanup short of full
 * watertight repair (which needs CGAL/admesh).
 */

import { readFile, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { join } from "node:path";
import type { StepResult, FileRef } from "../types.js";
import { parseStl, writeBinaryStl, triangleArea } from "./_stl-utils.js";

interface ToolContext {
  toolId: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRef[];
  scratchDir: string;
  emitProgress(bytes: number): void;
}

export default async function stlRepair(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "stl-repair requires one STL input");
  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);
  const tris = parseStl(buf);
  let removed = 0;
  const kept = tris.filter((t) => {
    if (!t.v.every((v) => v.every(Number.isFinite))) { removed += 1; return false; }
    if (triangleArea(t) < 1e-12) { removed += 1; return false; }
    return true;
  }).map((t) => {
    const [a, b, c] = t.v;
    const ab = [b![0] - a![0], b![1] - a![1], b![2] - a![2]];
    const ac = [c![0] - a![0], c![1] - a![1], c![2] - a![2]];
    const nx = ab[1]! * ac[2]! - ab[2]! * ac[1]!;
    const ny = ab[2]! * ac[0]! - ab[0]! * ac[2]!;
    const nz = ab[0]! * ac[1]! - ab[1]! * ac[0]!;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    return { nx: nx / len, ny: ny / len, nz: nz / len, v: t.v };
  });
  const out = writeBinaryStl(kept);
  const outRef = (ref.filename ?? ref.ref).replace(/\.stl$/i, ".repaired.stl");
  await writeFile(join(ctx.scratchDir, outRef), out);
  return { ok: true, outputs: { originalCount: tris.length, removedDegenerate: removed, keptCount: kept.length }, fileRefs: [{ ref: outRef, bytes: out.length, sha256: "", mime: "model/stl", filename: outRef }], bytesProcessed: totalIn, durationMs: Date.now() - start };
}

function sizeOrFallback(path: string, fallback: number): number { try { return statSync(path).size; } catch { return fallback; } }
function errorResult(code: string, message: string): StepResult { return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } }; }
