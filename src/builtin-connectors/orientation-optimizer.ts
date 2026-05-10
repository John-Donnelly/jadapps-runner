/**
 * orientation-optimizer: suggests an STL orientation that minimises
 * support material by trying the 6 axis-aligned rotations and picking
 * the one with the smallest underside area (faces with -Z normal).
 * Output is a JSON recommendation; doesn't rewrite the mesh.
 */

import { readFile, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { join } from "node:path";
import type { StepResult, FileRef } from "../types.js";
import { parseStl, triangleArea, type Triangle } from "./_stl-utils.js";

interface ToolContext {
  toolId: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRef[];
  scratchDir: string;
  emitProgress(bytes: number): void;
}

const ROTATIONS: { name: string; rotate: (t: Triangle) => Triangle }[] = [
  { name: "identity", rotate: (t) => t },
  { name: "rotate-x-180", rotate: (t) => ({ ...t, ny: -t.ny, nz: -t.nz, v: t.v.map(([x, y, z]) => [x, -y, -z]) as [number, number, number][] }) },
  { name: "rotate-y-90", rotate: (t) => ({ ...t, nx: t.nz, nz: -t.nx, v: t.v.map(([x, y, z]) => [z, y, -x]) as [number, number, number][] }) },
  { name: "rotate-y-180", rotate: (t) => ({ ...t, nx: -t.nx, nz: -t.nz, v: t.v.map(([x, y, z]) => [-x, y, -z]) as [number, number, number][] }) },
  { name: "rotate-y-270", rotate: (t) => ({ ...t, nx: -t.nz, nz: t.nx, v: t.v.map(([x, y, z]) => [-z, y, x]) as [number, number, number][] }) },
  { name: "rotate-x-90", rotate: (t) => ({ ...t, ny: -t.nz, nz: t.ny, v: t.v.map(([x, y, z]) => [x, -z, y]) as [number, number, number][] }) },
];

export default async function orientationOptimizer(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "orientation-optimizer requires one STL input");
  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);
  const tris = parseStl(buf);
  const evaluations: { rotation: string; supportArea: number }[] = [];
  for (const r of ROTATIONS) {
    const rotated = tris.map(r.rotate);
    let supportArea = 0;
    for (const t of rotated) if (t.nz < -0.5) supportArea += triangleArea(t);
    evaluations.push({ rotation: r.name, supportArea });
  }
  evaluations.sort((a, b) => a.supportArea - b.supportArea);
  const json = JSON.stringify({ file: ref.filename ?? ref.ref, recommendedRotation: evaluations[0]?.rotation, evaluations }, null, 2);
  const outRef = "orientation.json";
  await writeFile(join(ctx.scratchDir, outRef), json, "utf8");
  return { ok: true, outputs: { recommendedRotation: evaluations[0]?.rotation, minSupportArea: evaluations[0]?.supportArea }, fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(json, "utf8"), sha256: "", mime: "application/json", filename: outRef }], bytesProcessed: totalIn, durationMs: Date.now() - start };
}

function sizeOrFallback(path: string, fallback: number): number { try { return statSync(path).size; } catch { return fallback; } }
function errorResult(code: string, message: string): StepResult { return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } }; }
