/**
 * orientation-optimizer: recommends a print orientation by ranking the 6
 * axis-aligned poses on a weighted combination of bed contact (good),
 * overhang area >45° (bad), and footprint (slightly bad). The classifier
 * uses each pose's minZ to separate true overhangs from bed-contact
 * triangles — counting the bottom face as overhang would push the
 * algorithm toward edge-up orientations for flat plates.
 *
 * Output is a JSON recommendation; it doesn't rewrite the mesh.
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

// Six rotations. Each maps (x,y,z) to a new triple, and the corresponding
// normal transform is the same linear map (axis-aligned 90° rotations).
// The set is chosen so all six face-up directions (±X, ±Y, ±Z) are tested.
const ROTATIONS: { name: string; rotate: (t: Triangle) => Triangle }[] = [
  // +Z up
  { name: "identity", rotate: (t) => t },
  // -Z up (flip around X by 180°)
  { name: "rotate-x-180", rotate: (t) => ({
      nx: t.nx, ny: -t.ny, nz: -t.nz,
      v: t.v.map(([x, y, z]) => [x, -y, -z]) as [number, number, number][],
    }) },
  // +X up (rotate around Y by +90°: (x,y,z) → (z, y, -x))
  { name: "rotate-y-90", rotate: (t) => ({
      nx: t.nz, ny: t.ny, nz: -t.nx,
      v: t.v.map(([x, y, z]) => [z, y, -x]) as [number, number, number][],
    }) },
  // -X up (rotate around Y by -90°: (x,y,z) → (-z, y, x))
  { name: "rotate-y-270", rotate: (t) => ({
      nx: -t.nz, ny: t.ny, nz: t.nx,
      v: t.v.map(([x, y, z]) => [-z, y, x]) as [number, number, number][],
    }) },
  // -Y up (rotate around X by +90°: (x,y,z) → (x, -z, y))
  { name: "rotate-x-90", rotate: (t) => ({
      nx: t.nx, ny: -t.nz, nz: t.ny,
      v: t.v.map(([x, y, z]) => [x, -z, y]) as [number, number, number][],
    }) },
  // +Y up (rotate around X by -90°: (x,y,z) → (x, z, -y))
  { name: "rotate-x-270", rotate: (t) => ({
      nx: t.nx, ny: t.nz, nz: -t.ny,
      v: t.v.map(([x, y, z]) => [x, z, -y]) as [number, number, number][],
    }) },
];

const OVERHANG_COS_THRESHOLD = Math.cos(Math.PI / 4); // 45° from horizontal ≈ 0.707

interface RotationEval {
  rotation: string;
  score: number;
  supportArea: number;      // legacy field — kept = overhangArea
  overhangArea: number;
  bedContactArea: number;
  footprintArea: number;
}

function recomputeNormal(t: Triangle): { nx: number; ny: number; nz: number } {
  const [a, b, c] = t.v;
  if (!a || !b || !c) return { nx: 0, ny: 0, nz: 0 };
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  return { nx: nx / len, ny: ny / len, nz: nz / len };
}

function evaluateOrientation(name: string, tris: Triangle[]): RotationEval {
  // Pass 1: bounding box.
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const t of tris) {
    for (const [x, y, z] of t.v) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
  }
  const zRange = Math.max(0, maxZ - minZ);
  const bedTolerance = Math.max(1e-4, zRange * 0.005);

  // Pass 2: classify each down-facing triangle as bed-contact or overhang.
  // Normals are recomputed from rotated vertices to stay correct even when
  // the source STL stored zero/garbage normals.
  let overhangArea = 0;
  let bedContactArea = 0;
  for (const t of tris) {
    const { nz } = recomputeNormal(t);
    if (nz >= -OVERHANG_COS_THRESHOLD) continue;
    const area = triangleArea(t);
    const [a, b, c] = t.v;
    const allOnBed =
      a![2] <= minZ + bedTolerance &&
      b![2] <= minZ + bedTolerance &&
      c![2] <= minZ + bedTolerance;
    if (allOnBed) bedContactArea += area;
    else overhangArea += area;
  }
  const footprintArea = Math.max(0, maxX - minX) * Math.max(0, maxY - minY);
  // Lower score = better. Same weights as the in-browser implementation
  // in lib/3d/mesh-processor.ts so the two paths agree on the winner.
  const score = overhangArea * 5 + footprintArea * 0.001 - bedContactArea * 0.05;
  return {
    rotation: name,
    score: Math.round(score * 100) / 100,
    overhangArea: Math.round(overhangArea * 100) / 100,
    supportArea: Math.round(overhangArea * 100) / 100,
    bedContactArea: Math.round(bedContactArea * 100) / 100,
    footprintArea: Math.round(footprintArea * 100) / 100,
  };
}

export default async function orientationOptimizer(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "orientation-optimizer requires one STL input");
  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);
  const tris = parseStl(buf);
  const evaluations: RotationEval[] = [];
  for (const r of ROTATIONS) {
    const rotated = tris.map(r.rotate);
    evaluations.push(evaluateOrientation(r.name, rotated));
  }
  evaluations.sort((a, b) => a.score - b.score);
  const best = evaluations[0]!;
  const json = JSON.stringify({
    file: ref.filename ?? ref.ref,
    recommendedRotation: best.rotation,
    note: "Lower score is better. We reward bed contact, penalise overhangs >45°, and slightly penalise large footprints.",
    evaluations,
  }, null, 2);
  const outRef = "orientation.json";
  await writeFile(join(ctx.scratchDir, outRef), json, "utf8");
  return {
    ok: true,
    outputs: {
      recommendedRotation: best.rotation,
      minScore: best.score,
      bedContactArea: best.bedContactArea,
      overhangArea: best.overhangArea,
    },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(json, "utf8"), sha256: "", mime: "application/json", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function sizeOrFallback(path: string, fallback: number): number { try { return statSync(path).size; } catch { return fallback; } }
function errorResult(code: string, message: string): StepResult { return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } }; }
