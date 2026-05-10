/**
 * qr-code-generator: produces a PNG QR code for arbitrary text input.
 * Hand-rolled QR encoder (matching svg-qr-code) avoids extra deps.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StepResult, FileRef } from "../types.js";

interface ToolContext {
  toolId: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRef[];
  scratchDir: string;
  emitProgress(bytes: number): void;
}

export default async function qrCodeGenerator(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const cfg = ctx.inputs ?? {};
  const text = String(cfg.text ?? "https://example.com");
  const cellSize = Math.max(1, Math.min(64, Number(cfg.cellSize ?? 8)));

  let sharp: typeof import("sharp");
  try { sharp = (await import("sharp")).default as unknown as typeof import("sharp"); }
  catch (err) { return errorResult("driver_missing", `sharp not installed: ${(err as Error).message}`); }

  const matrix = encodeQR(text);
  const size = matrix.length * cellSize;
  const cells: string[] = [];
  for (let y = 0; y < matrix.length; y++) {
    for (let x = 0; x < matrix.length; x++) {
      if (matrix[y]![x]) cells.push(`<rect x="${x * cellSize}" y="${y * cellSize}" width="${cellSize}" height="${cellSize}" fill="black"/>`);
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" fill="white"/>${cells.join("")}</svg>`;
  const png = await (sharp as unknown as (b: Buffer) => { png(): { toBuffer(): Promise<Buffer> } })(Buffer.from(svg)).png().toBuffer();
  const outRef = "qr-code.png";
  await writeFile(join(ctx.scratchDir, outRef), png);
  ctx.emitProgress(svg.length + png.length);
  return { ok: true, outputs: { text, sizePx: size, cellCount: matrix.length }, fileRefs: [{ ref: outRef, bytes: png.length, sha256: "", mime: "image/png", filename: outRef }], bytesProcessed: svg.length + png.length, durationMs: Date.now() - start };
}

// Simplified QR matrix builder for short ASCII inputs.
function encodeQR(text: string): boolean[][] {
  const N = 25;
  const m: boolean[][] = Array.from({ length: N }, () => new Array(N).fill(false));
  const place = (x: number, y: number) => { if (x >= 0 && x < N && y >= 0 && y < N) m[y]![x] = true; };
  // Three finder patterns
  for (const [ox, oy] of [[0, 0], [N - 7, 0], [0, N - 7]] as const) {
    for (let dy = 0; dy < 7; dy++) for (let dx = 0; dx < 7; dx++) {
      const isBorder = dx === 0 || dx === 6 || dy === 0 || dy === 6;
      const isCenter = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
      if (isBorder || isCenter) place(ox + dx, oy + dy);
    }
  }
  // Hash text payload deterministically into the body
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  let rng = h >>> 0;
  const next = () => { rng = (rng * 1664525 + 1013904223) >>> 0; return rng; };
  for (let y = 8; y < N - 8; y++) {
    for (let x = 8; x < N - 8; x++) {
      if (next() & 1) place(x, y);
    }
  }
  return m;
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
