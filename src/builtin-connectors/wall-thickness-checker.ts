/**
 * wall-thickness-checker: estimates minimum wall thickness by sampling
 * vertex pairs and reporting the smallest opposite-face distance. Full
 * raycast-based analysis would need three.js — reports best-effort
 * approximation.
 */

import { readFile, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { join } from "node:path";
import type { StepResult, FileRef } from "../types.js";
import { parseStl } from "./_stl-utils.js";

interface ToolContext {
  toolId: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRef[];
  scratchDir: string;
  emitProgress(bytes: number): void;
}

export default async function wallThicknessChecker(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "wall-thickness-checker requires one STL input");
  const cfg = ctx.inputs ?? {};
  const minThickness = Number(cfg.minThickness ?? 0.8);

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);
  const tris = parseStl(buf);
  const sampleCount = Math.min(tris.length, 1000);
  const sampleStep = Math.max(1, Math.floor(tris.length / sampleCount));
  let minDistance = Infinity;
  let thinPairs = 0;
  for (let i = 0; i < tris.length; i += sampleStep) {
    const t1 = tris[i]!;
    const c1 = centroid(t1);
    for (let j = i + sampleStep; j < tris.length; j += sampleStep * 5) {
      const t2 = tris[j]!;
      // only consider opposing faces (normals roughly anti-parallel)
      const dot = t1.nx * t2.nx + t1.ny * t2.ny + t1.nz * t2.nz;
      if (dot > -0.5) continue;
      const c2 = centroid(t2);
      const d = Math.hypot(c1[0] - c2[0], c1[1] - c2[1], c1[2] - c2[2]);
      if (d < minDistance) minDistance = d;
      if (d < minThickness) thinPairs += 1;
    }
  }
  const json = JSON.stringify({ file: ref.filename ?? ref.ref, minThickness, sampledMinDistance: Number.isFinite(minDistance) ? minDistance : null, thinPairs, samplesAnalyzed: sampleCount }, null, 2);
  const outRef = "wall-thickness.json";
  await writeFile(join(ctx.scratchDir, outRef), json, "utf8");
  return { ok: true, outputs: { sampledMinDistance: Number.isFinite(minDistance) ? minDistance : null, thinPairs, passesThreshold: minDistance >= minThickness }, fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(json, "utf8"), sha256: "", mime: "application/json", filename: outRef }], bytesProcessed: totalIn, durationMs: Date.now() - start };
}

function centroid(t: ReturnType<typeof parseStl>[number]): [number, number, number] {
  const [a, b, c] = t.v;
  return [(a![0] + b![0] + c![0]) / 3, (a![1] + b![1] + c![1]) / 3, (a![2] + b![2] + c![2]) / 3];
}

function sizeOrFallback(path: string, fallback: number): number { try { return statSync(path).size; } catch { return fallback; } }
function errorResult(code: string, message: string): StepResult { return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } }; }
