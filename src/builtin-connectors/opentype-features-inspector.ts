/**
 * opentype-features-inspector: lists all OpenType features (GSUB / GPOS)
 * available in a font — ligatures (liga, dlig), small caps (smcp),
 * stylistic sets (ss01..ss20), kerning, etc.
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

export default async function opentypeFeaturesInspector(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "opentype-features-inspector requires one font input");

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

  const font = (fontkit as { create(b: Buffer): { availableFeatures?: string[] } }).create(buf);
  const features = (font.availableFeatures ?? []).slice();
  const friendly: Record<string, string> = {
    liga: "Standard Ligatures", dlig: "Discretionary Ligatures", smcp: "Small Caps",
    onum: "Old-style Figures", lnum: "Lining Figures", tnum: "Tabular Figures",
    pnum: "Proportional Figures", kern: "Kerning", frac: "Fractions",
    sups: "Superscript", subs: "Subscript", zero: "Slashed Zero",
  };

  const summary = {
    file: ref.filename ?? ref.ref,
    featureCount: features.length,
    features: features.map((f) => ({ tag: f, name: friendly[f] ?? "" })),
  };
  const out = JSON.stringify(summary, null, 2);
  const outRef = "opentype-features.json";
  await writeFile(join(ctx.scratchDir, outRef), out, "utf8");

  return {
    ok: true,
    outputs: { featureCount: features.length, features },
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
