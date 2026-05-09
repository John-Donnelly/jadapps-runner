/**
 * svg-blob-generator: produces a random organic blob SVG using a noise
 * function around a base radius. Configurable via `seed` for deterministic
 * output, `complexity` (4-30 segments), and `irregularity` (0-1).
 */

import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { StepResult, FileRef } from "../types.js";

interface ToolContext {
  toolId: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRef[];
  scratchDir: string;
  emitProgress(bytes: number): void;
}

export default async function svgBlobGenerator(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const cfg = ctx.inputs ?? {};
  const size = Math.max(50, Math.min(2048, Number(cfg.size ?? 400)));
  const complexity = Math.max(4, Math.min(30, Math.floor(Number(cfg.complexity ?? 10))));
  const irregularity = Math.max(0, Math.min(1, Number(cfg.irregularity ?? 0.4)));
  const fill = String(cfg.fill ?? "#4F46E5");
  const seed = cfg.seed != null ? String(cfg.seed) : `${Date.now()}-${Math.random()}`;
  const rng = mulberry32(hashSeed(seed));

  const cx = size / 2;
  const cy = size / 2;
  const baseR = size * 0.35;
  const points: [number, number][] = [];
  for (let i = 0; i < complexity; i++) {
    const angle = (Math.PI * 2 * i) / complexity;
    const r = baseR * (1 - irregularity * 0.5 + rng() * irregularity);
    points.push([cx + r * Math.cos(angle), cy + r * Math.sin(angle)]);
  }

  // Catmull-Rom-like smoothing into cubic Béziers.
  let path = `M${points[0]![0].toFixed(2)},${points[0]![1].toFixed(2)} `;
  for (let i = 0; i < complexity; i++) {
    const p0 = points[(i - 1 + complexity) % complexity]!;
    const p1 = points[i]!;
    const p2 = points[(i + 1) % complexity]!;
    const p3 = points[(i + 2) % complexity]!;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    path += `C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p2[0].toFixed(2)},${p2[1].toFixed(2)} `;
  }
  path += "Z";

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
  <path d="${path}" fill="${fill}"/>
</svg>
`;
  const outRef = "blob.svg";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, svg, "utf8");
  ctx.emitProgress(0);

  return {
    ok: true,
    outputs: { size, complexity, irregularity, seed },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(svg, "utf8"), sha256: "", mime: "image/svg+xml", filename: outRef }],
    bytesProcessed: 0,
    durationMs: Date.now() - start,
  };
}

function hashSeed(s: string): number { return createHash("sha256").update(s).digest().readUInt32BE(0); }
function mulberry32(a: number): () => number { return () => { let t = (a += 0x6D2B79F5); t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
