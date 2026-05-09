/**
 * svg-pattern-tiler: wraps an input SVG (a single tile) into a `<pattern>`
 * element and creates a containing SVG that renders the pattern across a
 * configurable canvas. Output is a self-contained SVG image.
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

export default async function svgPatternTiler(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "svg-pattern-tiler requires one SVG tile input");
  const cfg = ctx.inputs ?? {};
  const tileSize = Math.max(8, Math.min(512, Number(cfg.tileSize ?? 64)));
  const canvasWidth = Math.max(64, Math.min(8192, Number(cfg.canvasWidth ?? 1200)));
  const canvasHeight = Math.max(64, Math.min(8192, Number(cfg.canvasHeight ?? 800)));
  const background = String(cfg.background ?? "#ffffff");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const tileSvg = await readFile(inPath, "utf8");
  ctx.emitProgress(totalIn);

  // Strip the outer <svg> wrapper from the tile so its inner contents go
  // inside our <pattern>.
  const inner = tileSvg.replace(/<\?xml[\s\S]*?\?>/g, "").replace(/<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${canvasWidth} ${canvasHeight}" width="${canvasWidth}" height="${canvasHeight}">
  <defs>
    <pattern id="tile" x="0" y="0" width="${tileSize}" height="${tileSize}" patternUnits="userSpaceOnUse">
      <svg viewBox="0 0 ${tileSize} ${tileSize}" width="${tileSize}" height="${tileSize}">${inner}</svg>
    </pattern>
  </defs>
  <rect width="${canvasWidth}" height="${canvasHeight}" fill="${background}"/>
  <rect width="${canvasWidth}" height="${canvasHeight}" fill="url(#tile)"/>
</svg>
`;

  const outRef = "tiled.svg";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, svg, "utf8");

  return {
    ok: true,
    outputs: { tileSize, canvasWidth, canvasHeight },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(svg, "utf8"), sha256: "", mime: "image/svg+xml", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
