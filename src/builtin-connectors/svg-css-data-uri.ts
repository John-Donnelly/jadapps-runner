/**
 * svg-css-data-uri: encodes an SVG as a CSS-friendly data URI. Uses URL
 * encoding (smaller than base64 for SVG) wrapped in `url("…")`. Outputs
 * a snippet ready to paste into a stylesheet's background-image.
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

export default async function svgCssDataUri(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "svg-css-data-uri requires one SVG input");
  const cfg = ctx.inputs ?? {};
  const useBase64 = cfg.base64 === true;

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);

  let dataUrl: string;
  if (useBase64) {
    dataUrl = `data:image/svg+xml;base64,${buf.toString("base64")}`;
  } else {
    // URL-encode but keep safe characters readable.
    const encoded = buf.toString("utf8")
      .replace(/[\r\n\t]+/g, " ")
      .replace(/\s{2,}/g, " ")
      .replace(/"/g, "'")
      .replace(/[<>#%{}|\\^]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    dataUrl = `data:image/svg+xml;utf8,${encoded}`;
  }

  const cssSnippet = `background-image: url("${dataUrl}");`;
  const outRef = (ref.filename ?? "image.svg").replace(/\.svg$/i, "") + ".css";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, cssSnippet, "utf8");

  return {
    ok: true,
    outputs: { dataUrl, cssSnippet, encoding: useBase64 ? "base64" : "utf8", originalBytes: totalIn, encodedLength: dataUrl.length },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(cssSnippet, "utf8"), sha256: "", mime: "text/css", filename: outRef }],
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
