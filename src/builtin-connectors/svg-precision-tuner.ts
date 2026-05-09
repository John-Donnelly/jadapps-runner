/**
 * svg-precision-tuner: rounds numeric coordinates in path `d` attributes,
 * transforms, and viewBox to a chosen number of decimals (default 2).
 * Reduces file size meaningfully on hand-edited SVGs.
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

export default async function svgPrecisionTuner(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "svg-precision-tuner requires one SVG input");
  const cfg = ctx.inputs ?? {};
  const decimals = Math.max(0, Math.min(8, Math.floor(Number(cfg.decimals ?? 2))));

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const text = await readFile(inPath, "utf8");
  ctx.emitProgress(totalIn);

  const factor = Math.pow(10, decimals);
  const numberRe = /(-?\d+\.\d+)/g;
  const round = (s: string) => s.replace(numberRe, (m) => {
    const n = Math.round(Number(m) * factor) / factor;
    return String(n);
  });

  // Round inside path d="...", points="...", transform="...", viewBox="..."
  let result = text.replace(/(\b(?:d|points|transform|viewBox)=")([^"]+)(")/gi, (_, pre, body, post) => {
    return pre + round(body) + post;
  });
  // Round x/y/cx/cy/r/rx/ry/x1/y1/x2/y2/width/height attributes too.
  result = result.replace(/(\b(?:x|y|cx|cy|r|rx|ry|x1|y1|x2|y2|width|height|stroke-width)=")(-?\d+\.\d+)(")/gi, (_, pre, value, post) => {
    return pre + round(value) + post;
  });

  const outRef = ref.filename ?? "tuned.svg";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, result, "utf8");

  return {
    ok: true,
    outputs: { decimals, savedBytes: totalIn - Buffer.byteLength(result, "utf8") },
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
