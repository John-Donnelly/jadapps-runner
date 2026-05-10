/**
 * font-metadata-extractor: pulls the name table, OS/2 metrics, and
 * head-table info from an input font using @pdf-lib/fontkit. Outputs
 * a JSON report suitable for licensing review or integrity checks.
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

export default async function fontMetadataExtractor(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "font-metadata-extractor requires one font input");

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

  const font = (fontkit as { create(b: Buffer): Record<string, unknown> }).create(buf);
  const metadata = {
    fullName: font.fullName,
    familyName: font.familyName,
    subfamilyName: font.subfamilyName,
    postscriptName: font.postscriptName,
    copyright: font.copyright,
    version: font.version,
    unitsPerEm: font.unitsPerEm,
    ascent: font.ascent,
    descent: font.descent,
    lineGap: font.lineGap,
    underlinePosition: font.underlinePosition,
    underlineThickness: font.underlineThickness,
    italicAngle: font.italicAngle,
    capHeight: font.capHeight,
    xHeight: font.xHeight,
    bbox: font.bbox,
    numGlyphs: font.numGlyphs,
  };
  const out = JSON.stringify({ file: ref.filename ?? ref.ref, metadata }, null, 2);
  const outRef = "font-metadata.json";
  await writeFile(join(ctx.scratchDir, outRef), out, "utf8");

  return {
    ok: true,
    outputs: { familyName: String(metadata.familyName ?? ""), version: String(metadata.version ?? ""), numGlyphs: Number(metadata.numGlyphs ?? 0) },
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
