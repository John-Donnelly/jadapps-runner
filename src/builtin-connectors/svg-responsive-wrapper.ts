/**
 * svg-responsive-wrapper: ensures an SVG scales fluidly. Strips any fixed
 * width/height on the root, sets `preserveAspectRatio` if missing, and
 * synthesises a viewBox if one isn't present.
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

export default async function svgResponsiveWrapper(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "svg-responsive-wrapper requires one SVG input");
  const cfg = ctx.inputs ?? {};
  const preserveAspect = String(cfg.preserveAspectRatio ?? "xMidYMid meet");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const text = await readFile(inPath, "utf8");
  ctx.emitProgress(totalIn);

  const openTagMatch = /<svg([^>]*)>/i.exec(text);
  if (!openTagMatch || !openTagMatch[1]) return errorResult("invalid_input", "no <svg> root element");

  let attrs = openTagMatch[1];
  const widthMatch = /\bwidth="?(\d+(?:\.\d+)?)"?/i.exec(attrs);
  const heightMatch = /\bheight="?(\d+(?:\.\d+)?)"?/i.exec(attrs);
  const viewBoxMatch = /\bviewBox="[^"]+"/i.exec(attrs);

  // Synthesise viewBox if missing.
  if (!viewBoxMatch && widthMatch && heightMatch) {
    attrs += ` viewBox="0 0 ${widthMatch[1]} ${heightMatch[1]}"`;
  }

  // Strip fixed width/height.
  attrs = attrs.replace(/\s*\bwidth="?\d+(?:\.\d+)?"?/gi, "");
  attrs = attrs.replace(/\s*\bheight="?\d+(?:\.\d+)?"?/gi, "");

  // Add preserveAspectRatio if missing.
  if (!/preserveAspectRatio=/i.test(attrs)) {
    attrs += ` preserveAspectRatio="${preserveAspect}"`;
  }

  const replaced = text.slice(0, openTagMatch.index) + `<svg${attrs}>` + text.slice(openTagMatch.index + openTagMatch[0].length);
  const outRef = ref.filename ?? "responsive.svg";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, replaced, "utf8");

  return {
    ok: true,
    outputs: { hadViewBox: viewBoxMatch != null, hadWidth: widthMatch != null, preserveAspect },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(replaced, "utf8"), sha256: "", mime: "image/svg+xml", filename: outRef }],
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
