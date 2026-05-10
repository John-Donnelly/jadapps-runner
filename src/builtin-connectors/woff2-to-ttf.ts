/**
 * woff2-to-ttf: decodes a WOFF2 file back to TTF/OTF using `wawoff2`'s
 * decompress API (Brotli + table reconstruction). driver_missing if
 * wawoff2 isn't installed.
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

export default async function woff2ToTtf(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "woff2-to-ttf requires one WOFF2 input");

  let wawoff: { decompress(b: Buffer): Promise<Uint8Array> };
  try {
    const mod = await import("wawoff2");
    wawoff = mod as unknown as { decompress(b: Buffer): Promise<Uint8Array> };
  } catch (err) {
    return errorResult("driver_missing", `wawoff2 not installed: ${(err as Error).message}`);
  }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const woff2 = await readFile(inPath);
  const ttf = Buffer.from(await wawoff.decompress(woff2));
  ctx.emitProgress(totalIn);

  const outRef = (ref.filename ?? ref.ref).replace(/\.woff2$/i, ".ttf");
  await writeFile(join(ctx.scratchDir, outRef), ttf);

  return {
    ok: true,
    outputs: { woff2Bytes: woff2.length, ttfBytes: ttf.length },
    fileRefs: [{ ref: outRef, bytes: ttf.length, sha256: "", mime: "font/ttf", filename: outRef }],
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
