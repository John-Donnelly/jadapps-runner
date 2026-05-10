/**
 * image-slicer: slices an image into a NxM grid of tiles. Output
 * names: tile-r{row}c{col}.png.
 */

import { readFile, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { join } from "node:path";
import type { StepResult, FileRef } from "../types.js";

interface ToolContext {
  toolId: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRef[];
  scratchDir: string;
  emitProgress(bytes: number): void;
}

export default async function imageSlicer(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "image-slicer requires one image input");
  let sharp: typeof import("sharp");
  try { sharp = (await import("sharp")).default as unknown as typeof import("sharp"); }
  catch (err) { return errorResult("driver_missing", `sharp not installed: ${(err as Error).message}`); }
  const cfg = ctx.inputs ?? {};
  const cols = Math.max(1, Math.min(64, Number(cfg.columns ?? 3)));
  const rows = Math.max(1, Math.min(64, Number(cfg.rows ?? 3)));
  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);
  const factory = sharp as unknown as (b: Buffer) => {
    metadata(): Promise<{ width?: number; height?: number }>;
    extract(o: { left: number; top: number; width: number; height: number }): { png(): { toBuffer(): Promise<Buffer> } };
  };
  const meta = await factory(buf).metadata();
  const w = meta.width ?? 0, h = meta.height ?? 0;
  if (w === 0 || h === 0) return errorResult("invalid_image", "could not read image dimensions");
  const tileW = Math.floor(w / cols);
  const tileH = Math.floor(h / rows);

  const fileRefs: FileRef[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const tile = await factory(buf).extract({ left: c * tileW, top: r * tileH, width: tileW, height: tileH }).png().toBuffer();
      const name = `tile-r${r}c${c}.png`;
      await writeFile(join(ctx.scratchDir, name), tile);
      fileRefs.push({ ref: name, bytes: tile.length, sha256: "", mime: "image/png", filename: name });
    }
  }
  return { ok: true, outputs: { cols, rows, tileWidth: tileW, tileHeight: tileH, tileCount: cols * rows }, fileRefs, bytesProcessed: totalIn, durationMs: Date.now() - start };
}

function sizeOrFallback(path: string, fallback: number): number { try { return statSync(path).size; } catch { return fallback; } }
function errorResult(code: string, message: string): StepResult { return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } }; }
