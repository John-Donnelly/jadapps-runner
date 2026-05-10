/**
 * normal-fixer: recomputes all triangle normals from vertex positions
 * (right-hand rule), correcting STLs with bogus or zero normals.
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

export default async function normalFixer(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "normal-fixer requires one STL input");
  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);
  const tris = parseStl(buf).map((t) => {
    const [a, b, c] = t.v;
    const ab = [b![0] - a![0], b![1] - a![1], b![2] - a![2]];
    const ac = [c![0] - a![0], c![1] - a![1], c![2] - a![2]];
    const nx = ab[1]! * ac[2]! - ab[2]! * ac[1]!;
    const ny = ab[2]! * ac[0]! - ab[0]! * ac[2]!;
    const nz = ab[0]! * ac[1]! - ab[1]! * ac[0]!;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    return { nx: nx / len, ny: ny / len, nz: nz / len, v: t.v };
  });
  const out = writeBinaryStl(tris);
  const outRef = (ref.filename ?? ref.ref).replace(/\.stl$/i, ".fixed-normals.stl");
  await writeFile(join(ctx.scratchDir, outRef), out);
  return { ok: true, outputs: { triangleCount: tris.length }, fileRefs: [{ ref: outRef, bytes: out.length, sha256: "", mime: "model/stl", filename: outRef }], bytesProcessed: totalIn, durationMs: Date.now() - start };
}

function sizeOrFallback(path: string, fallback: number): number { try { return statSync(path).size; } catch { return fallback; } }
function errorResult(code: string, message: string): StepResult { return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } }; }
