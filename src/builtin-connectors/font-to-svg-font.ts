/**
 * font-to-svg-font: extracts each glyph as an SVG <path> element and
 * emits a single SVG-font document compatible with `font-face` (legacy
 * but still useful for static rendering pipelines).
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

export default async function fontToSvgFont(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "font-to-svg-font requires one font input");

  let fontkit: unknown;
  try {
    const fontkitMod = await import("@pdf-lib/fontkit");
    fontkit = (fontkitMod as unknown as { default?: unknown }).default ?? fontkitMod;
  } catch (err) {
    return errorResult("driver_missing", `@pdf-lib/fontkit not installed: ${(err as Error).message}`);
  }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);

  const font = (fontkit as { create(b: Buffer): {
    unitsPerEm?: number; ascent?: number; descent?: number; familyName?: string;
    numGlyphs?: number; getGlyph?(id: number): { id: number; advanceWidth?: number; codePoints?: number[]; path?: { toSVG(): string } };
  } }).create(buf);

  const upm = font.unitsPerEm ?? 1000;
  const ascent = font.ascent ?? upm;
  const descent = font.descent ?? -200;
  const familyName = font.familyName ?? "ConvertedFont";
  const numGlyphs = Math.min(font.numGlyphs ?? 0, 4096);

  const glyphElements: string[] = [];
  let exported = 0;
  for (let i = 0; i < numGlyphs; i++) {
    const g = font.getGlyph?.(i);
    if (!g || !g.path) continue;
    const cp = g.codePoints && g.codePoints.length > 0 ? g.codePoints[0] : null;
    const adv = g.advanceWidth ?? upm;
    const unicodeAttr = cp ? ` unicode="&#${cp};"` : "";
    const d = g.path.toSVG();
    glyphElements.push(`<glyph${unicodeAttr} horiz-adv-x="${adv}" d="${escapeAttr(d)}" />`);
    exported += 1;
  }

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg">
  <defs>
    <font id="${familyName}" horiz-adv-x="${upm}">
      <font-face font-family="${familyName}" units-per-em="${upm}" ascent="${ascent}" descent="${descent}" />
      ${glyphElements.join("\n      ")}
    </font>
  </defs>
</svg>
`;

  const outRef = (ref.filename ?? ref.ref).replace(/\.(ttf|otf)$/i, ".svg");
  await writeFile(join(ctx.scratchDir, outRef), svg, "utf8");

  return {
    ok: true,
    outputs: { glyphsExported: exported, unitsPerEm: upm, familyName },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(svg, "utf8"), sha256: "", mime: "image/svg+xml", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
