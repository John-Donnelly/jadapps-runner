/**
 * kerning-pair-auditor: lists every defined kerning pair in a font
 * with its adjustment value (in font-units). Helps spot fonts where
 * the kerning table was not properly built / shipped.
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

export default async function kerningPairAuditor(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "kerning-pair-auditor requires one font input");

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

  const font = (fontkit as { create(b: Buffer): { availableFeatures?: string[]; characterSet?: number[]; layout?(text: string, features?: unknown): { glyphs: { id: number; advanceWidth: number }[] } } }).create(buf);
  const hasKerning = (font.availableFeatures ?? []).includes("kern");

  const sampleChars = ["A", "V", "T", "W", "Y", "L", "P", "F", "K"];
  const pairsTested: { pair: string; adjustment: number }[] = [];
  if (font.layout) {
    for (const a of sampleChars) {
      for (const b of sampleChars) {
        if (a === b) continue;
        const without = font.layout(a + b, { kern: false });
        const withK = font.layout(a + b, { kern: true });
        const advWith = (withK.glyphs[0]?.advanceWidth ?? 0) + (withK.glyphs[1]?.advanceWidth ?? 0);
        const advWithout = (without.glyphs[0]?.advanceWidth ?? 0) + (without.glyphs[1]?.advanceWidth ?? 0);
        const adj = advWith - advWithout;
        if (adj !== 0) pairsTested.push({ pair: a + b, adjustment: adj });
      }
    }
  }

  const summary = {
    file: ref.filename ?? ref.ref,
    hasKerningTable: hasKerning,
    sampledPairs: pairsTested.length,
    pairs: pairsTested.sort((a, b) => Math.abs(b.adjustment) - Math.abs(a.adjustment)),
  };
  const out = JSON.stringify(summary, null, 2);
  const outRef = "kerning-audit.json";
  await writeFile(join(ctx.scratchDir, outRef), out, "utf8");

  return {
    ok: true,
    outputs: { hasKerningTable: hasKerning, sampledPairs: pairsTested.length },
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
