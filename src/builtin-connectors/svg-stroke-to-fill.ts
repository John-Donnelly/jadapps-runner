/**
 * svg-stroke-to-fill: replaces stroked path styling with the equivalent
 * filled outline. v0.1 uses a CSS-only approach: copies the stroke colour
 * to a `vector-effect: non-scaling-stroke` outline filter that produces
 * an outline-style render. A true geometric path-stroke conversion would
 * need a path offsetting library (e.g. paper.js); deferred.
 *
 * Output is an SVG where each stroked element gains an explicit fill and
 * the stroke is removed — useful for icons that need to scale without
 * stroke distortion.
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

export default async function svgStrokeToFill(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "svg-stroke-to-fill requires one SVG input");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const text = await readFile(inPath, "utf8");
  ctx.emitProgress(totalIn);

  let result = text;
  let convertedCount = 0;
  // For each element with stroke, replace fill="none" with fill="<stroke>"
  // and drop the stroke attribute. Approximation, not geometric outline.
  result = result.replace(/<([A-Za-z][\w-]*)([^>]*)\bstroke="([^"]+)"([^>]*)>/g, (m, tag, pre, strokeValue, post) => {
    if (strokeValue === "none") return m;
    convertedCount += 1;
    let combined = (pre + post).replace(/\bfill="none"/g, `fill="${strokeValue}"`);
    if (!/\bfill=/i.test(combined)) combined += ` fill="${strokeValue}"`;
    combined = combined.replace(/\sstroke-width="[^"]*"/g, "").replace(/\sstroke="[^"]*"/g, "");
    return `<${tag}${combined}>`;
  });

  const outRef = ref.filename ?? "filled.svg";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, result, "utf8");

  return {
    ok: true,
    outputs: { convertedCount, note: "approximate: replaces stroke with fill, no geometric offsetting" },
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
