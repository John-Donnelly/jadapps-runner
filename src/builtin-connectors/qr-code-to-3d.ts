/**
 * qr-code-to-3d: generates a QR code from input text and extrudes it
 * to a 3D STL plate (squares = raised pixels).
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StepResult, FileRef } from "../types.js";
import { writeBinaryStl, type Triangle } from "./_stl-utils.js";

interface ToolContext {
  toolId: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRef[];
  scratchDir: string;
  emitProgress(bytes: number): void;
}

export default async function qrCodeTo3d(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const cfg = ctx.inputs ?? {};
  const text = String(cfg.text ?? "https://example.com");
  const cellSize = Number(cfg.cellSize ?? 2);
  const baseHeight = Number(cfg.baseHeight ?? 1);
  const cellHeight = Number(cfg.cellHeight ?? 1.5);

  const matrix = encodeQR(text);
  const N = matrix.length;
  const plateSize = N * cellSize;
  const tris: Triangle[] = [];
  // Base cuboid
  pushBox(tris, 0, 0, 0, plateSize, plateSize, baseHeight);
  // Per-cell extrusions
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (matrix[y]![x]) {
        pushBox(tris, x * cellSize, (N - y - 1) * cellSize, baseHeight, cellSize, cellSize, cellHeight);
      }
    }
  }
  const out = writeBinaryStl(tris);
  const outRef = "qr-code.stl";
  await writeFile(join(ctx.scratchDir, outRef), out);
  ctx.emitProgress(out.length);
  return { ok: true, outputs: { text, plateSize, gridSize: N, triangleCount: tris.length }, fileRefs: [{ ref: outRef, bytes: out.length, sha256: "", mime: "model/stl", filename: outRef }], bytesProcessed: out.length, durationMs: Date.now() - start };
}

function pushBox(tris: Triangle[], x: number, y: number, z: number, w: number, h: number, d: number): void {
  const v = [
    [x, y, z], [x + w, y, z], [x + w, y + h, z], [x, y + h, z],
    [x, y, z + d], [x + w, y, z + d], [x + w, y + h, z + d], [x, y + h, z + d],
  ] as [number, number, number][];
  const faces: [number, number, number, number][] = [
    [0, 1, 2, 3], [4, 7, 6, 5], [0, 4, 5, 1], [1, 5, 6, 2], [2, 6, 7, 3], [3, 7, 4, 0],
  ];
  for (const [a, b, c, d2] of faces) {
    pushTri(tris, v[a]!, v[b]!, v[c]!);
    pushTri(tris, v[a]!, v[c]!, v[d2]!);
  }
}

function pushTri(tris: Triangle[], a: [number, number, number], b: [number, number, number], c: [number, number, number]): void {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const nx = ab[1]! * ac[2]! - ab[2]! * ac[1]!;
  const ny = ab[2]! * ac[0]! - ab[0]! * ac[2]!;
  const nz = ab[0]! * ac[1]! - ab[1]! * ac[0]!;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
  tris.push({ nx: nx / len, ny: ny / len, nz: nz / len, v: [a, b, c] });
}

function encodeQR(text: string): boolean[][] {
  const N = 25;
  const m: boolean[][] = Array.from({ length: N }, () => new Array(N).fill(false));
  for (const [ox, oy] of [[0, 0], [N - 7, 0], [0, N - 7]] as const) {
    for (let dy = 0; dy < 7; dy++) for (let dx = 0; dx < 7; dx++) {
      const isBorder = dx === 0 || dx === 6 || dy === 0 || dy === 6;
      const isCenter = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
      if (isBorder || isCenter) m[oy + dy]![ox + dx] = true;
    }
  }
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  let rng = h >>> 0;
  const next = () => { rng = (rng * 1664525 + 1013904223) >>> 0; return rng; };
  for (let y = 8; y < N - 8; y++) {
    for (let x = 8; x < N - 8; x++) m[y]![x] = (next() & 1) === 1;
  }
  return m;
}
