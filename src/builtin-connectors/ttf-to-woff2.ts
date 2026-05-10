/**
 * ttf-to-woff2: WOFF2 uses a custom Brotli-based table transform that
 * is non-trivial to implement from scratch. Reports driver_missing if
 * `wawoff2` (the official wasm port) is not installed.
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

export default async function ttfToWoff2(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "ttf-to-woff2 requires one TTF/OTF input");

  let wawoff: { compress(b: Buffer): Promise<Uint8Array> };
  try {
    const mod = await import("wawoff2");
    wawoff = mod as unknown as { compress(b: Buffer): Promise<Uint8Array> };
  } catch (err) {
    return errorResult("driver_missing", `wawoff2 not installed: ${(err as Error).message}. Install with \`npm i wawoff2\` to enable WOFF2 conversion.`);
  }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const ttf = await readFile(inPath);
  const woff2 = Buffer.from(await wawoff.compress(ttf));
  ctx.emitProgress(totalIn);

  const outRef = (ref.filename ?? ref.ref).replace(/\.(ttf|otf)$/i, ".woff2");
  await writeFile(join(ctx.scratchDir, outRef), woff2);

  return {
    ok: true,
    outputs: { ttfBytes: ttf.length, woff2Bytes: woff2.length, ratio: woff2.length / ttf.length },
    fileRefs: [{ ref: outRef, bytes: woff2.length, sha256: "", mime: "font/woff2", filename: outRef }],
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
