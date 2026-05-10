/**
 * glyph-count-analyzer: reports how many glyphs the font contains and
 * how many are mapped from each Unicode block (Latin, Cyrillic, CJK,
 * symbols, etc.). Useful for licensing and webfont sizing decisions.
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

const BLOCKS: { name: string; from: number; to: number }[] = [
  { name: "Basic Latin", from: 0x0020, to: 0x007F },
  { name: "Latin-1 Supplement", from: 0x00A0, to: 0x00FF },
  { name: "Latin Extended-A", from: 0x0100, to: 0x017F },
  { name: "Latin Extended-B", from: 0x0180, to: 0x024F },
  { name: "Greek", from: 0x0370, to: 0x03FF },
  { name: "Cyrillic", from: 0x0400, to: 0x04FF },
  { name: "Hebrew", from: 0x0590, to: 0x05FF },
  { name: "Arabic", from: 0x0600, to: 0x06FF },
  { name: "Devanagari", from: 0x0900, to: 0x097F },
  { name: "Thai", from: 0x0E00, to: 0x0E7F },
  { name: "General Punctuation", from: 0x2000, to: 0x206F },
  { name: "Currency", from: 0x20A0, to: 0x20CF },
  { name: "Mathematical Operators", from: 0x2200, to: 0x22FF },
  { name: "CJK Unified Ideographs", from: 0x4E00, to: 0x9FFF },
  { name: "Hiragana", from: 0x3040, to: 0x309F },
  { name: "Katakana", from: 0x30A0, to: 0x30FF },
  { name: "Hangul", from: 0xAC00, to: 0xD7AF },
  { name: "Emoji (BMP)", from: 0x2600, to: 0x27BF },
];

export default async function glyphCountAnalyzer(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "glyph-count-analyzer requires one font input");

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

  const font = (fontkit as { create(b: Buffer): { numGlyphs?: number; characterSet?: number[]; hasGlyphForCodePoint?(cp: number): boolean } }).create(buf);
  const numGlyphs = font.numGlyphs ?? 0;
  const codePoints: number[] = font.characterSet ?? [];

  const blockCounts: { name: string; count: number; range: string }[] = BLOCKS.map((b) => ({
    name: b.name,
    count: codePoints.filter((c) => c >= b.from && c <= b.to).length,
    range: `U+${b.from.toString(16).toUpperCase()}..${b.to.toString(16).toUpperCase()}`,
  }));

  const summary = {
    file: ref.filename ?? ref.ref,
    numGlyphs,
    mappedCodePoints: codePoints.length,
    blocks: blockCounts.filter((b) => b.count > 0),
  };
  const out = JSON.stringify(summary, null, 2);
  const outRef = "glyph-count.json";
  await writeFile(join(ctx.scratchDir, outRef), out, "utf8");

  return {
    ok: true,
    outputs: { numGlyphs, mappedCodePoints: codePoints.length, blockCount: summary.blocks.length },
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
