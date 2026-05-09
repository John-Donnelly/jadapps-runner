/**
 * svg-compression-estimator: reports how much each minification technique
 * would save without modifying the input. Tries: comments-strip, metadata-
 * strip, whitespace-collapse, default-attr-strip, decimal-rounding (1 dp),
 * and gzip on the wire. Useful before deciding which transformations to
 * apply.
 */

import { readFile, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import type { StepResult, FileRef } from "../types.js";

interface ToolContext {
  toolId: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRef[];
  scratchDir: string;
  emitProgress(bytes: number): void;
}

export default async function svgCompressionEstimator(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "svg-compression-estimator requires one SVG input");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const text = await readFile(inPath, "utf8");
  ctx.emitProgress(totalIn);

  const original = Buffer.byteLength(text, "utf8");
  const techniques: Record<string, number> = {};

  techniques.commentsRemoved = byteSavings(text, /<!--[\s\S]*?-->/g);
  techniques.metadataRemoved = byteSavings(text, /<(?:title|desc|metadata)[^>]*>[\s\S]*?<\/(?:title|desc|metadata)>/g);
  techniques.editorAttrsRemoved = byteSavings(text, /\s+(?:sodipodi|inkscape):[a-z][\w-]*="[^"]*"/gi);
  techniques.whitespaceCollapsed = (() => {
    const collapsed = text.replace(/>\s+</g, "><").replace(/\s{2,}/g, " ");
    return original - Buffer.byteLength(collapsed, "utf8");
  })();
  techniques.decimalsRounded1dp = (() => {
    const rounded = text.replace(/-?\d+\.\d+/g, (n) => String(Math.round(Number(n) * 10) / 10));
    return original - Buffer.byteLength(rounded, "utf8");
  })();

  const cumulative = (() => {
    let v = text;
    v = v.replace(/<!--[\s\S]*?-->/g, "");
    v = v.replace(/<(?:title|desc|metadata)[^>]*>[\s\S]*?<\/(?:title|desc|metadata)>/g, "");
    v = v.replace(/\s+(?:sodipodi|inkscape):[a-z][\w-]*="[^"]*"/gi, "");
    v = v.replace(/>\s+</g, "><").replace(/\s{2,}/g, " ");
    v = v.replace(/-?\d+\.\d+/g, (n) => String(Math.round(Number(n) * 10) / 10));
    return original - Buffer.byteLength(v, "utf8");
  })();

  const gzipped = gzipSync(Buffer.from(text)).length;

  const report = JSON.stringify({
    originalBytes: original,
    techniques,
    cumulativeSavingsBytes: cumulative,
    cumulativeSavingsPct: original > 0 ? Math.round((cumulative / original) * 100) : 0,
    gzippedBytes: gzipped,
    gzipSavingsPct: original > 0 ? Math.round((1 - gzipped / original) * 100) : 0,
  }, null, 2);

  const outRef = "compression-estimate.json";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, report, "utf8");

  return {
    ok: true,
    outputs: { originalBytes: original, cumulativeSavingsBytes: cumulative, gzippedBytes: gzipped },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(report, "utf8"), sha256: "", mime: "application/json", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function byteSavings(text: string, re: RegExp): number {
  const before = Buffer.byteLength(text, "utf8");
  const after = Buffer.byteLength(text.replace(re, ""), "utf8");
  return before - after;
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
