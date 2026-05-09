/**
 * svg-viewbox-fixer: synthesises a viewBox attribute on the root <svg>
 * when one is missing, using the explicit width/height attributes (or a
 * supplied default).
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

export default async function svgViewboxFixer(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "svg-viewbox-fixer requires one SVG input");
  const cfg = ctx.inputs ?? {};
  const defaultWidth = Number(cfg.defaultWidth ?? 24);
  const defaultHeight = Number(cfg.defaultHeight ?? 24);

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const text = await readFile(inPath, "utf8");
  ctx.emitProgress(totalIn);

  const openTagMatch = /<svg([^>]*)>/i.exec(text);
  if (!openTagMatch || !openTagMatch[1]) return errorResult("invalid_input", "no <svg> root element");

  const attrs = openTagMatch[1];
  if (/\bviewBox=/i.test(attrs)) {
    const outRef = ref.filename ?? "out.svg";
    const outPath = join(ctx.scratchDir, outRef);
    await writeFile(outPath, text, "utf8");
    return { ok: true, outputs: { hadViewBox: true, action: "no-op" }, fileRefs: [{ ref: outRef, bytes: totalIn, sha256: "", mime: "image/svg+xml", filename: outRef }], bytesProcessed: totalIn, durationMs: Date.now() - start };
  }

  const widthMatch = /\bwidth="?(\d+(?:\.\d+)?)/i.exec(attrs);
  const heightMatch = /\bheight="?(\d+(?:\.\d+)?)/i.exec(attrs);
  const w = widthMatch ? Number(widthMatch[1]) : defaultWidth;
  const h = heightMatch ? Number(heightMatch[1]) : defaultHeight;
  const newAttrs = `${attrs} viewBox="0 0 ${w} ${h}"`;
  const result = text.slice(0, openTagMatch.index) + `<svg${newAttrs}>` + text.slice(openTagMatch.index + openTagMatch[0].length);

  const outRef = ref.filename ?? "fixed.svg";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, result, "utf8");

  return {
    ok: true,
    outputs: { hadViewBox: false, viewBox: `0 0 ${w} ${h}`, source: widthMatch ? "explicit-width-height" : "default" },
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
