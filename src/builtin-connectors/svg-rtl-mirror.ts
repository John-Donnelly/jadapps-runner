/**
 * svg-rtl-mirror: horizontally mirrors the entire SVG by wrapping its
 * children in a `<g transform="scale(-1,1) translate(-W,0)">` group. Used
 * for right-to-left locales where directional iconography (arrows,
 * caret-only icons, etc.) needs flipping.
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

export default async function svgRtlMirror(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "svg-rtl-mirror requires one SVG input");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const text = await readFile(inPath, "utf8");
  ctx.emitProgress(totalIn);

  const widthMatch = /<svg[^>]*\bwidth="?(\d+(?:\.\d+)?)/i.exec(text);
  const viewBoxMatch = /<svg[^>]*\bviewBox="(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)"/i.exec(text);
  let width = 0;
  if (widthMatch && widthMatch[1]) width = Number(widthMatch[1]);
  else if (viewBoxMatch && viewBoxMatch[3]) width = Number(viewBoxMatch[3]);
  if (width <= 0) return errorResult("invalid_input", "could not determine SVG width from width or viewBox");

  const openTagMatch = /<svg[^>]*>/i.exec(text);
  if (!openTagMatch) return errorResult("invalid_input", "no <svg> root element");
  const closeTag = "</svg>";
  const openEnd = openTagMatch.index + openTagMatch[0].length;
  const closeStart = text.lastIndexOf(closeTag);
  if (closeStart < 0) return errorResult("invalid_input", "no </svg> closing tag");

  const wrapped = text.slice(0, openEnd) +
    `\n  <g transform="translate(${width},0) scale(-1,1)">\n` +
    text.slice(openEnd, closeStart) +
    `\n  </g>\n` +
    text.slice(closeStart);

  const outRef = ref.filename ?? "mirrored.svg";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, wrapped, "utf8");

  return {
    ok: true,
    outputs: { width },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(wrapped, "utf8"), sha256: "", mime: "image/svg+xml", filename: outRef }],
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
