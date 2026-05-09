/**
 * svg-metadata-scrubber: removes <title>, <desc>, <metadata>, namespace
 * attributes used by editors (sodipodi:*, inkscape:*), and authoring
 * comments. The visual result is unchanged.
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

export default async function svgMetadataScrubber(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "svg-metadata-scrubber requires one SVG input");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const text = await readFile(inPath, "utf8");
  ctx.emitProgress(totalIn);

  let cleaned = text;
  let removedCount = 0;
  const patterns: { name: string; re: RegExp }[] = [
    { name: "title", re: /<title[^>]*>[\s\S]*?<\/title>/g },
    { name: "desc", re: /<desc[^>]*>[\s\S]*?<\/desc>/g },
    { name: "metadata", re: /<metadata[^>]*>[\s\S]*?<\/metadata>/g },
    { name: "comments", re: /<!--[\s\S]*?-->/g },
    { name: "sodipodi-attrs", re: /\s+sodipodi:[a-z][\w-]*="[^"]*"/g },
    { name: "inkscape-attrs", re: /\s+inkscape:[a-z][\w-]*="[^"]*"/g },
    { name: "sodipodi-ns", re: /\s+xmlns:sodipodi="[^"]*"/g },
    { name: "inkscape-ns", re: /\s+xmlns:inkscape="[^"]*"/g },
  ];
  for (const { re } of patterns) {
    const before = cleaned.length;
    cleaned = cleaned.replace(re, "");
    if (cleaned.length !== before) removedCount += 1;
  }

  const outRef = ref.filename ?? "scrubbed.svg";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, cleaned, "utf8");

  return {
    ok: true,
    outputs: { savedBytes: totalIn - Buffer.byteLength(cleaned, "utf8"), patternsHit: removedCount },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(cleaned, "utf8"), sha256: "", mime: "image/svg+xml", filename: outRef }],
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
