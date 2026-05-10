/**
 * font-to-base64: emits a CSS @font-face block with the font payload
 * inlined as a base64 data: URL. Useful for self-contained docs and
 * email templates where remote font URLs are blocked.
 */

import { readFile, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { extname, join } from "node:path";
import type { StepResult, FileRef } from "../types.js";

interface ToolContext {
  toolId: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRef[];
  scratchDir: string;
  emitProgress(bytes: number): void;
}

export default async function fontToBase64(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "font-to-base64 requires one font file input");
  const cfg = ctx.inputs ?? {};
  const family = String(cfg.family ?? "InlinedFont");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);

  const ext = extname(ref.filename ?? ref.ref).toLowerCase().replace(".", "");
  const mime = ext === "woff2" ? "font/woff2" : ext === "woff" ? "font/woff" : ext === "ttf" ? "font/ttf" : "font/otf";
  const fmt = ext === "woff2" ? "woff2" : ext === "woff" ? "woff" : ext === "ttf" ? "truetype" : "opentype";
  const b64 = buf.toString("base64");

  const css = [
    `@font-face {`,
    `  font-family: "${family}";`,
    `  src: url("data:${mime};base64,${b64}") format("${fmt}");`,
    `  font-weight: 400;`,
    `  font-style: normal;`,
    `  font-display: swap;`,
    `}`,
    ``,
  ].join("\n");

  const outRef = `${family}.inlined.css`;
  await writeFile(join(ctx.scratchDir, outRef), css, "utf8");

  return {
    ok: true,
    outputs: { family, fontFormat: fmt, originalBytes: buf.length, base64Bytes: b64.length },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(css, "utf8"), sha256: "", mime: "text/css", filename: outRef }],
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
