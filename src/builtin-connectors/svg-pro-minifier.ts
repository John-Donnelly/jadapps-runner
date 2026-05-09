/**
 * svg-pro-minifier: heavy SVG minification — strips comments, metadata,
 * default attribute values, removes whitespace between tags, and rounds
 * coordinates to 2 decimals. Aggressive; the visual result should match
 * but tooling that depends on namespaces or editor metadata will lose them.
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

export default async function svgProMinifier(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "svg-pro-minifier requires one SVG input");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const text = await readFile(inPath, "utf8");
  ctx.emitProgress(totalIn);

  let result = text;
  // Comments + xml declaration
  result = result.replace(/<!--[\s\S]*?-->/g, "");
  result = result.replace(/<\?xml[\s\S]*?\?>/g, "");
  // Editor metadata
  result = result.replace(/<title[^>]*>[\s\S]*?<\/title>/g, "");
  result = result.replace(/<desc[^>]*>[\s\S]*?<\/desc>/g, "");
  result = result.replace(/<metadata[^>]*>[\s\S]*?<\/metadata>/g, "");
  result = result.replace(/\s+(?:sodipodi|inkscape):[a-z][\w-]*="[^"]*"/gi, "");
  result = result.replace(/\s+xmlns:(?:sodipodi|inkscape)="[^"]*"/gi, "");
  // Default attribute values
  result = result.replace(/\s+(?:fill-rule|stroke-linecap|stroke-linejoin|stroke-miterlimit|stroke-dashoffset)="(?:nonzero|butt|miter|4|0)"/gi, "");
  result = result.replace(/\s+stroke-opacity="1"/gi, "");
  result = result.replace(/\s+fill-opacity="1"/gi, "");
  result = result.replace(/\s+opacity="1"/gi, "");
  // Whitespace between tags + repeated whitespace inside
  result = result.replace(/>\s+</g, "><");
  result = result.replace(/\s{2,}/g, " ");
  // Round numeric values
  const numberRe = /(-?\d+\.\d+)/g;
  result = result.replace(/(\b(?:d|points|transform|viewBox)=")([^"]+)(")/gi, (_, pre, body, post) => {
    return pre + body.replace(numberRe, (m: string) => String(Math.round(Number(m) * 100) / 100)) + post;
  });

  const outRef = ref.filename ?? "min.svg";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, result, "utf8");

  return {
    ok: true,
    outputs: { savedBytes: totalIn - Buffer.byteLength(result, "utf8"), savedPct: totalIn > 0 ? Math.round((1 - Buffer.byteLength(result, "utf8") / totalIn) * 100) : 0 },
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
