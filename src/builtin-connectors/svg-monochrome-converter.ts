/**
 * svg-monochrome-converter: replaces every fill/stroke colour in the SVG
 * with a single target colour. Whites and `none` values are preserved by
 * default; opt out via `replaceWhite=true`.
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

export default async function svgMonochromeConverter(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "svg-monochrome-converter requires one SVG input");
  const cfg = ctx.inputs ?? {};
  const target = String(cfg.color ?? "#000000");
  const replaceWhite = cfg.replaceWhite === true;
  const targetStroke = String(cfg.strokeColor ?? target);

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const text = await readFile(inPath, "utf8");
  ctx.emitProgress(totalIn);

  let result = text;
  let fills = 0, strokes = 0;
  result = result.replace(/(\sfill=")([^"]+)(")/gi, (m, pre, value, post) => {
    const v = value.toLowerCase();
    if (v === "none") return m;
    if (!replaceWhite && (v === "#fff" || v === "#ffffff" || v === "white")) return m;
    fills += 1;
    return `${pre}${target}${post}`;
  });
  result = result.replace(/(\sstroke=")([^"]+)(")/gi, (m, pre, value, post) => {
    const v = value.toLowerCase();
    if (v === "none") return m;
    if (!replaceWhite && (v === "#fff" || v === "#ffffff" || v === "white")) return m;
    strokes += 1;
    return `${pre}${targetStroke}${post}`;
  });
  // Style attribute fills (fill: #abc;) and stop-color
  result = result.replace(/(fill\s*:\s*)([^;"\s]+)/gi, (m, pre, value) => {
    const v = value.toLowerCase();
    if (v === "none") return m;
    if (!replaceWhite && (v === "#fff" || v === "#ffffff" || v === "white")) return m;
    fills += 1;
    return `${pre}${target}`;
  });

  const outRef = ref.filename ?? "monochrome.svg";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, result, "utf8");

  return {
    ok: true,
    outputs: { fillsChanged: fills, strokesChanged: strokes, target, replaceWhite },
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
