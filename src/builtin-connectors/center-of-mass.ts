/**
 * center-of-mass: computes the volume-weighted centroid (centre of mass)
 * of a closed STL mesh, assuming uniform density.
 */

import { readFile, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { join } from "node:path";
import type { StepResult, FileRef } from "../types.js";
import { parseStl, signedTetraVolume } from "./_stl-utils.js";

interface ToolContext {
  toolId: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRef[];
  scratchDir: string;
  emitProgress(bytes: number): void;
}

export default async function centerOfMass(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "center-of-mass requires one STL input");
  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);
  const tris = parseStl(buf);
  let totalV = 0;
  let cx = 0, cy = 0, cz = 0;
  for (const t of tris) {
    const [a, b, c] = t.v;
    if (!a || !b || !c) continue;
    const v = signedTetraVolume(t);
    totalV += v;
    cx += v * (a[0] + b[0] + c[0]) / 4;
    cy += v * (a[1] + b[1] + c[1]) / 4;
    cz += v * (a[2] + b[2] + c[2]) / 4;
  }
  const com = totalV !== 0 ? [cx / totalV, cy / totalV, cz / totalV] : [0, 0, 0];
  const json = JSON.stringify({ file: ref.filename ?? ref.ref, volume: totalV, centerOfMass: com }, null, 2);
  const outRef = "center-of-mass.json";
  await writeFile(join(ctx.scratchDir, outRef), json, "utf8");
  return { ok: true, outputs: { centerOfMass: com, volume: totalV }, fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(json, "utf8"), sha256: "", mime: "application/json", filename: outRef }], bytesProcessed: totalIn, durationMs: Date.now() - start };
}

function sizeOrFallback(path: string, fallback: number): number { try { return statSync(path).size; } catch { return fallback; } }
function errorResult(code: string, message: string): StepResult { return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } }; }
