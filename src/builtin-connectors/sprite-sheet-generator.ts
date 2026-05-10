/**
 * sprite-sheet-generator: composes multiple input images into a single
 * tile-grid sprite sheet, plus a JSON manifest of (x, y, width, height)
 * coordinates.
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

export default async function spriteSheetGenerator(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  if (!Array.isArray(ctx.fileRefs) || ctx.fileRefs.length === 0) {
    return errorResult("missing_input", "sprite-sheet-generator requires at least one input");
  }
  let sharp: typeof import("sharp");
  try { sharp = (await import("sharp")).default as unknown as typeof import("sharp"); }
  catch (err) { return errorResult("driver_missing", `sharp not installed: ${(err as Error).message}`); }
  const cfg = ctx.inputs ?? {};
  const tileSize = Math.max(8, Number(cfg.tileSize ?? 64));
  const cols = Math.max(1, Number(cfg.columns ?? Math.ceil(Math.sqrt(ctx.fileRefs.length))));
  const rows = Math.ceil(ctx.fileRefs.length / cols);
  const sheetWidth = cols * tileSize;
  const sheetHeight = rows * tileSize;

  let totalIn = 0;
  const factory = sharp as unknown as (input: Buffer | object) => {
    resize(w: number, h: number, opts?: object): { toBuffer(): Promise<Buffer> };
    composite(c: { input: Buffer; left: number; top: number }[]): { png(): { toBuffer(): Promise<Buffer> } };
  };

  const composites: { input: Buffer; left: number; top: number }[] = [];
  const manifest: { name: string; x: number; y: number; w: number; h: number }[] = [];
  for (let i = 0; i < ctx.fileRefs.length; i++) {
    const ref = ctx.fileRefs[i]!;
    const path = join(ctx.scratchDir, ref.ref);
    totalIn += sizeOrFallback(path, ref.bytes);
    const tileBuf = await factory(await readFile(path)).resize(tileSize, tileSize, { fit: "cover" }).toBuffer();
    const col = i % cols;
    const row = Math.floor(i / cols);
    composites.push({ input: tileBuf, left: col * tileSize, top: row * tileSize });
    manifest.push({ name: ref.filename ?? ref.ref, x: col * tileSize, y: row * tileSize, w: tileSize, h: tileSize });
  }
  ctx.emitProgress(totalIn);

  const sheet = await factory({ create: { width: sheetWidth, height: sheetHeight, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } } as unknown as object).composite(composites).png().toBuffer();
  await writeFile(join(ctx.scratchDir, "sprites.png"), sheet);
  await writeFile(join(ctx.scratchDir, "sprites.json"), JSON.stringify({ width: sheetWidth, height: sheetHeight, tileSize, cols, rows, sprites: manifest }, null, 2), "utf8");

  return {
    ok: true,
    outputs: { tileCount: ctx.fileRefs.length, cols, rows, sheetWidth, sheetHeight },
    fileRefs: [
      { ref: "sprites.png", bytes: sheet.length, sha256: "", mime: "image/png", filename: "sprites.png" },
      { ref: "sprites.json", bytes: 0, sha256: "", mime: "application/json", filename: "sprites.json" },
    ],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function sizeOrFallback(path: string, fallback: number): number { try { return statSync(path).size; } catch { return fallback; } }
function errorResult(code: string, message: string): StepResult { return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } }; }
