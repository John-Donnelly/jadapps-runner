/**
 * svg-font-to-path: converts `<text>` elements in an SVG into vector
 * `<path>` elements using a supplied font (.ttf or .otf). Useful when you
 * need to ship an SVG that doesn't depend on the viewer having the font
 * installed.
 *
 * Uses fontkit (already a dep via @pdf-lib/fontkit). Currently supports
 * single-line text without complex shaping; v0.2 should integrate
 * harfbuzzjs for proper kerning/ligature handling.
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

export default async function svgFontToPath(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  if (!Array.isArray(ctx.fileRefs) || ctx.fileRefs.length < 2) {
    return errorResult("missing_input", "svg-font-to-path requires an SVG and a font file");
  }

  let fontkit: typeof import("@pdf-lib/fontkit");
  try { fontkit = (await import("@pdf-lib/fontkit")).default as typeof import("@pdf-lib/fontkit"); }
  catch (err) { return errorResult("driver_missing", `@pdf-lib/fontkit not installed: ${(err as Error).message}`); }

  const svgRef = ctx.fileRefs[0]!;
  const fontRef = ctx.fileRefs[1]!;
  const svgPath = join(ctx.scratchDir, svgRef.ref);
  const fontPath = join(ctx.scratchDir, fontRef.ref);
  const totalIn = sizeOrFallback(svgPath, svgRef.bytes) + sizeOrFallback(fontPath, fontRef.bytes);
  const svgText = await readFile(svgPath, "utf8");
  const fontBuf = await readFile(fontPath);
  const font = (fontkit as unknown as { create(buf: Buffer): { layout(text: string): { glyphs: { path: { toSVG(): string } }[] }; unitsPerEm: number } }).create(fontBuf);
  ctx.emitProgress(totalIn);

  let convertedCount = 0;
  const result = svgText.replace(/<text([^>]*)>([\s\S]*?)<\/text>/g, (_match, attrs, body) => {
    const text = (body as string).trim();
    if (!text) return "";
    const fontSizeMatch = /\bfont-size="?(\d+(?:\.\d+)?)/.exec(attrs);
    const xMatch = /\bx="?(-?\d+(?:\.\d+)?)/.exec(attrs);
    const yMatch = /\by="?(-?\d+(?:\.\d+)?)/.exec(attrs);
    const fillMatch = /\bfill="([^"]+)"/.exec(attrs);
    const fontSize = fontSizeMatch ? Number(fontSizeMatch[1]) : 16;
    const x = xMatch ? Number(xMatch[1]) : 0;
    const y = yMatch ? Number(yMatch[1]) : 0;
    const fill = fillMatch ? fillMatch[1] : "#000000";

    try {
      const layout = font.layout(text);
      const scale = fontSize / font.unitsPerEm;
      const glyphPaths = layout.glyphs.map((g) => g.path.toSVG()).join(" ");
      convertedCount += 1;
      return `<g transform="translate(${x.toFixed(2)},${y.toFixed(2)}) scale(${scale.toFixed(6)},-${scale.toFixed(6)})" fill="${fill}"><path d="${glyphPaths}"/></g>`;
    } catch {
      return _match;
    }
  });

  const outRef = svgRef.filename ?? "outlined.svg";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, result, "utf8");

  return {
    ok: true,
    outputs: { convertedCount },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(result, "utf8"), sha256: "", mime: "image/svg+xml", filename: outRef }],
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
