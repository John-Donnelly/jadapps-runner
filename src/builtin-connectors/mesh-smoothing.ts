/**
 * mesh-smoothing: applies Laplacian smoothing to an STL mesh — moves
 * each vertex toward the average of its neighbours over N iterations.
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

export default async function meshSmoothing(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "mesh-smoothing requires one STL input");
  const cfg = ctx.inputs ?? {};
  const iterations = Math.max(1, Math.min(20, Number(cfg.iterations ?? 3)));
  const lambda = Math.max(0.01, Math.min(1, Number(cfg.lambda ?? 0.5)));

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);
  const tris = parseStl(buf);

  // Build vertex registry + adjacency from triangles.
  const vertKey = new Map<string, number>();
  const verts: [number, number, number][] = [];
  const triIndices: [number, number, number][] = [];
  for (const t of tris) {
    const ids = t.v.map((v) => {
      const k = v.map((c) => c.toFixed(6)).join(",");
      let id = vertKey.get(k);
      if (id === undefined) { id = verts.length; vertKey.set(k, id); verts.push([...v] as [number, number, number]); }
      return id;
    }) as [number, number, number];
    triIndices.push(ids);
  }
  const neighbours: Set<number>[] = verts.map(() => new Set<number>());
  for (const [a, b, c] of triIndices) {
    neighbours[a]!.add(b); neighbours[a]!.add(c);
    neighbours[b]!.add(a); neighbours[b]!.add(c);
    neighbours[c]!.add(a); neighbours[c]!.add(b);
  }

  for (let iter = 0; iter < iterations; iter++) {
    const next: [number, number, number][] = verts.map(() => [0, 0, 0]);
    for (let i = 0; i < verts.length; i++) {
      const ns = neighbours[i]!;
      if (ns.size === 0) { next[i] = verts[i]!; continue; }
      let sx = 0, sy = 0, sz = 0;
      for (const j of ns) { sx += verts[j]![0]; sy += verts[j]![1]; sz += verts[j]![2]; }
      const ax = sx / ns.size, ay = sy / ns.size, az = sz / ns.size;
      const v = verts[i]!;
      next[i] = [v[0] + lambda * (ax - v[0]), v[1] + lambda * (ay - v[1]), v[2] + lambda * (az - v[2])];
    }
    for (let i = 0; i < verts.length; i++) verts[i] = next[i]!;
  }

  const newTris = triIndices.map(([a, b, c]) => {
    const va = verts[a]!, vb = verts[b]!, vc = verts[c]!;
    const ab = [vb[0] - va[0], vb[1] - va[1], vb[2] - va[2]];
    const ac = [vc[0] - va[0], vc[1] - va[1], vc[2] - va[2]];
    const nx = ab[1]! * ac[2]! - ab[2]! * ac[1]!;
    const ny = ab[2]! * ac[0]! - ab[0]! * ac[2]!;
    const nz = ab[0]! * ac[1]! - ab[1]! * ac[0]!;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    return { nx: nx / len, ny: ny / len, nz: nz / len, v: [va, vb, vc] as [number, number, number][] };
  });
  const out = writeBinaryStl(newTris);
  const outRef = (ref.filename ?? ref.ref).replace(/\.stl$/i, ".smooth.stl");
  await writeFile(join(ctx.scratchDir, outRef), out);
  return { ok: true, outputs: { iterations, lambda, vertexCount: verts.length, triangleCount: newTris.length }, fileRefs: [{ ref: outRef, bytes: out.length, sha256: "", mime: "model/stl", filename: outRef }], bytesProcessed: totalIn, durationMs: Date.now() - start };
}

function sizeOrFallback(path: string, fallback: number): number { try { return statSync(path).size; } catch { return fallback; } }
function errorResult(code: string, message: string): StepResult { return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } }; }
