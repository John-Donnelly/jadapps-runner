/**
 * glyph-inspector: emits a JSON listing of every glyph in a font with
 * its glyph index, advance width, and Unicode mapping (when present).
 * Intended for debugging missing-character bugs in production fonts.
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

export default async function glyphInspector(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "glyph-inspector requires one font input");

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

  const font = (fontkit as { create(b: Buffer): { numGlyphs?: number; getGlyph?(id: number): { id: number; advanceWidth?: number; codePoints?: number[]; name?: string } } }).create(buf);
  const numGlyphs = font.numGlyphs ?? 0;
  const glyphs: { id: number; name?: string; advanceWidth?: number; codePoint?: number }[] = [];
  for (let i = 0; i < Math.min(numGlyphs, 65535); i++) {
    try {
      const g = font.getGlyph?.(i);
      if (!g) continue;
      const entry: { id: number; name?: string; advanceWidth?: number; codePoint?: number } = { id: i };
      if (g.name) entry.name = g.name;
      if (typeof g.advanceWidth === "number") entry.advanceWidth = g.advanceWidth;
      if (g.codePoints && g.codePoints.length > 0 && typeof g.codePoints[0] === "number") entry.codePoint = g.codePoints[0];
      glyphs.push(entry);
    } catch { /* skip individual glyph errors */ }
  }

  const out = JSON.stringify({ file: ref.filename ?? ref.ref, numGlyphs, glyphs }, null, 2);
  const outRef = "glyph-inspection.json";
  await writeFile(join(ctx.scratchDir, outRef), out, "utf8");

  return {
    ok: true,
    outputs: { numGlyphs, inspected: glyphs.length },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(out, "utf8"), sha256: "", mime: "application/json", filename: outRef }],
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
