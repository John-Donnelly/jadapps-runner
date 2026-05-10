/**
 * z-axis-flipper: mirrors an STL across the Z axis (negates Z and
 * inverts triangle winding to keep normals outward).
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

export default async function zAxisFlipper(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "z-axis-flipper requires one STL input");
  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);
  const tris = parseStl(buf).map((t) => ({
    nx: t.nx, ny: t.ny, nz: -t.nz,
    v: [t.v[0]!, t.v[2]!, t.v[1]!].map(([x, y, z]) => [x, y, -z]) as [number, number, number][],
  }));
  const out = writeBinaryStl(tris);
  const outRef = (ref.filename ?? ref.ref).replace(/\.stl$/i, ".zflip.stl");
  await writeFile(join(ctx.scratchDir, outRef), out);
  return { ok: true, outputs: { triangleCount: tris.length }, fileRefs: [{ ref: outRef, bytes: out.length, sha256: "", mime: "model/stl", filename: outRef }], bytesProcessed: totalIn, durationMs: Date.now() - start };
}

function sizeOrFallback(path: string, fallback: number): number { try { return statSync(path).size; } catch { return fallback; } }
function errorResult(code: string, message: string): StepResult { return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } }; }
