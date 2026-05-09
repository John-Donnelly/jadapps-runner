/**
 * svg-path-simplifier: simplifies path `d` attributes by collapsing
 * consecutive duplicate commands and removing redundant precision. A
 * proper Ramer-Douglas-Peucker simplification would need a curve-aware
 * implementation; v0.1 focuses on coordinate cleanup that's safe.
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

export default async function svgPathSimplifier(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "svg-path-simplifier requires one SVG input");
  const cfg = ctx.inputs ?? {};
  const decimals = Math.max(0, Math.min(6, Math.floor(Number(cfg.decimals ?? 1))));

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const text = await readFile(inPath, "utf8");
  ctx.emitProgress(totalIn);

  const factor = Math.pow(10, decimals);
  let pathsTouched = 0;
  const result = text.replace(/(\bd=")([^"]+)(")/gi, (_, pre, body, post) => {
    pathsTouched += 1;
    const cleaned = (body as string)
      // Round numbers
      .replace(/-?\d+\.\d+/g, (n) => String(Math.round(Number(n) * factor) / factor))
      // Collapse runs of whitespace
      .replace(/\s+/g, " ")
      // Drop spaces around commands
      .replace(/\s*([MmLlHhVvCcSsQqTtAaZz])\s*/g, "$1");
    return pre + cleaned.trim() + post;
  });

  const outRef = ref.filename ?? "simplified.svg";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, result, "utf8");

  return {
    ok: true,
    outputs: { pathsTouched, decimals, savedBytes: totalIn - Buffer.byteLength(result, "utf8") },
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
