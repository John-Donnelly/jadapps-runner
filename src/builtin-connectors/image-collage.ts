/**
 * image-collage: composes multiple images into a single grid layout.
 * Auto-determines columns from input count if not specified.
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

export default async function imageCollage(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  if (!Array.isArray(ctx.fileRefs) || ctx.fileRefs.length === 0) {
    return errorResult("missing_input", "image-collage requires at least one image input");
  }
  let sharp: typeof import("sharp");
  try { sharp = (await import("sharp")).default as unknown as typeof import("sharp"); }
  catch (err) { return errorResult("driver_missing", `sharp not installed: ${(err as Error).message}`); }
  const cfg = ctx.inputs ?? {};
  const cellSize = Math.max(64, Number(cfg.cellSize ?? 400));
  const cols = Math.max(1, Number(cfg.columns ?? Math.ceil(Math.sqrt(ctx.fileRefs.length))));
  const rows = Math.ceil(ctx.fileRefs.length / cols);
  const gap = Math.max(0, Number(cfg.gap ?? 8));
  const totalWidth = cols * cellSize + (cols + 1) * gap;
  const totalHeight = rows * cellSize + (rows + 1) * gap;

  const factory = sharp as unknown as (input: Buffer | object) => {
    resize(w: number, h: number, opts: object): { toBuffer(): Promise<Buffer> };
    composite(c: { input: Buffer; left: number; top: number }[]): { jpeg(o: { quality: number }): { toBuffer(): Promise<Buffer> } };
  };

  const composites: { input: Buffer; left: number; top: number }[] = [];
  let totalIn = 0;
  for (let i = 0; i < ctx.fileRefs.length; i++) {
    const ref = ctx.fileRefs[i]!;
    const path = join(ctx.scratchDir, ref.ref);
    totalIn += sizeOrFallback(path, ref.bytes);
    const tile = await factory(await readFile(path)).resize(cellSize, cellSize, { fit: "cover" }).toBuffer();
    const c = i % cols, r = Math.floor(i / cols);
    composites.push({ input: tile, left: gap + c * (cellSize + gap), top: gap + r * (cellSize + gap) });
  }
  ctx.emitProgress(totalIn);

  const out = await factory({ create: { width: totalWidth, height: totalHeight, channels: 3, background: { r: 240, g: 240, b: 240 } } } as unknown as object).composite(composites).jpeg({ quality: 90 }).toBuffer();
  const outRef = "collage.jpg";
  await writeFile(join(ctx.scratchDir, outRef), out);
  return { ok: true, outputs: { tiles: ctx.fileRefs.length, cols, rows, totalWidth, totalHeight }, fileRefs: [{ ref: outRef, bytes: out.length, sha256: "", mime: "image/jpeg", filename: outRef }], bytesProcessed: totalIn, durationMs: Date.now() - start };
}

function sizeOrFallback(path: string, fallback: number): number { try { return statSync(path).size; } catch { return fallback; } }
function errorResult(code: string, message: string): StepResult { return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } }; }
