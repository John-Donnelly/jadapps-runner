/**
 * 3d-thumbnailer: renders a top-down preview of an STL by projecting
 * its triangles onto the XY plane and shading by Z. Pure-Node fallback;
 * full PBR rendering would need three.js + headless GL.
 */

import { readFile, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { join } from "node:path";
import type { StepResult, FileRef } from "../types.js";
import { parseStl, computeBoundingBox } from "./_stl-utils.js";

interface ToolContext {
  toolId: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRef[];
  scratchDir: string;
  emitProgress(bytes: number): void;
}

export default async function threeDThumbnailer(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "3d-thumbnailer requires one STL input");
  const cfg = ctx.inputs ?? {};
  const size = Math.max(64, Math.min(1024, Number(cfg.size ?? 400)));
  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);
  const tris = parseStl(buf);
  const bb = computeBoundingBox(tris);
  const w = bb.size[0] || 1, h = bb.size[1] || 1, d = bb.size[2] || 1;
  const maxDim = Math.max(w, h);
  const scale = (size - 20) / maxDim;
  const tx = -bb.min[0] * scale + 10;
  const ty = -bb.min[1] * scale + 10;
  const polys: string[] = [];
  // Sort by average Z descending (Painter's algorithm — far first).
  const sorted = tris.slice().sort((a, b) => {
    const za = (a.v[0]![2] + a.v[1]![2] + a.v[2]![2]) / 3;
    const zb = (b.v[0]![2] + b.v[1]![2] + b.v[2]![2]) / 3;
    return za - zb;
  });
  for (const t of sorted) {
    const z = (t.v[0]![2] + t.v[1]![2] + t.v[2]![2]) / 3;
    const norm = (z - bb.min[2]) / d;
    const grey = Math.round(96 + 128 * norm);
    const points = t.v.map(([x, y]) => `${(x * scale + tx).toFixed(2)},${(size - (y * scale + ty)).toFixed(2)}`).join(" ");
    polys.push(`<polygon points="${points}" fill="rgb(${grey},${grey},${grey})" stroke="rgb(${Math.max(0, grey - 30)},${Math.max(0, grey - 30)},${Math.max(0, grey - 30)})" stroke-width="0.3"/>`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" fill="#fafafa"/>${polys.join("")}</svg>`;
  const outRef = "thumbnail.svg";
  await writeFile(join(ctx.scratchDir, outRef), svg, "utf8");
  return { ok: true, outputs: { triangleCount: tris.length, sizePx: size }, fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(svg, "utf8"), sha256: "", mime: "image/svg+xml", filename: outRef }], bytesProcessed: totalIn, durationMs: Date.now() - start };
}

function sizeOrFallback(path: string, fallback: number): number { try { return statSync(path).size; } catch { return fallback; } }
function errorResult(code: string, message: string): StepResult { return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } }; }
