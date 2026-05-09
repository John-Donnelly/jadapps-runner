/**
 * svg-to-base64: encodes an SVG as a base64 data URL. Outputs both the
 * raw base64 string and a CSS-ready `url("data:image/svg+xml;base64,...")`.
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

export default async function svgToBase64(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "svg-to-base64 requires one SVG input");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);

  const base64 = buf.toString("base64");
  const dataUrl = `data:image/svg+xml;base64,${base64}`;
  const cssUrl = `url("${dataUrl}")`;

  const outRef = (ref.filename ?? "image.svg").replace(/\.svg$/i, "") + ".dataurl.txt";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, dataUrl, "utf8");

  return {
    ok: true,
    outputs: { base64, dataUrl, cssUrl, originalBytes: totalIn, encodedLength: base64.length },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(dataUrl, "utf8"), sha256: "", mime: "text/plain", filename: outRef }],
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
