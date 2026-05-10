/**
 * variable-font-axis-mapper: enumerates every variable axis in a font
 * with min/max/default/name, and emits a CSS @supports block + JSON
 * map ready for use with font-variation-settings.
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

export default async function variableFontAxisMapper(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "variable-font-axis-mapper requires one font input");

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

  const font = (fontkit as { create(b: Buffer): { variationAxes?: Record<string, { name: string; min: number; max: number; default: number }>; namedVariations?: Record<string, Record<string, number>> } }).create(buf);
  const axes = font.variationAxes ?? {};
  const named = font.namedVariations ?? {};

  const axisList = Object.entries(axes).map(([tag, info]) => ({ tag, name: info.name, min: info.min, max: info.max, default: info.default }));
  const cssLines = [".vf-default { font-variation-settings: " + axisList.map((a) => `"${a.tag}" ${a.default}`).join(", ") + "; }"];
  for (const [name, instance] of Object.entries(named)) {
    const settings = Object.entries(instance).map(([t, v]) => `"${t}" ${v}`).join(", ");
    cssLines.push(`.vf-${name.toLowerCase().replace(/\s+/g, "-")} { font-variation-settings: ${settings}; }`);
  }
  const css = cssLines.join("\n") + "\n";

  const json = JSON.stringify({ file: ref.filename ?? ref.ref, axes: axisList, namedInstances: named }, null, 2);
  await writeFile(join(ctx.scratchDir, "variable-axes.json"), json, "utf8");
  await writeFile(join(ctx.scratchDir, "variable-axes.css"), css, "utf8");

  return {
    ok: true,
    outputs: { axisCount: axisList.length, namedInstanceCount: Object.keys(named).length },
    fileRefs: [
      { ref: "variable-axes.json", bytes: Buffer.byteLength(json, "utf8"), sha256: "", mime: "application/json", filename: "variable-axes.json" },
      { ref: "variable-axes.css", bytes: Buffer.byteLength(css, "utf8"), sha256: "", mime: "text/css", filename: "variable-axes.css" },
    ],
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
