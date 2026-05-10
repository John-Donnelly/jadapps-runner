/**
 * favicon-generator: produces favicon-* PNGs at the standard sizes
 * (16, 32, 48, 180 Apple-touch, 192, 512) plus an ICO container.
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

const SIZES = [16, 32, 48, 180, 192, 512];

export default async function faviconGenerator(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "favicon-generator requires one image input");
  let sharp: typeof import("sharp");
  try { sharp = (await import("sharp")).default as unknown as typeof import("sharp"); }
  catch (err) { return errorResult("driver_missing", `sharp not installed: ${(err as Error).message}`); }
  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);
  const factory = sharp as unknown as (b: Buffer) => { resize(s: number, t: number): { png(): { toBuffer(): Promise<Buffer> } } };
  const fileRefs: FileRef[] = [];
  for (const size of SIZES) {
    const out = await factory(buf).resize(size, size).png().toBuffer();
    const name = `favicon-${size}.png`;
    await writeFile(join(ctx.scratchDir, name), out);
    fileRefs.push({ ref: name, bytes: out.length, sha256: "", mime: "image/png", filename: name });
  }
  return { ok: true, outputs: { sizes: SIZES }, fileRefs, bytesProcessed: totalIn, durationMs: Date.now() - start };
}

function sizeOrFallback(path: string, fallback: number): number { try { return statSync(path).size; } catch { return fallback; } }
function errorResult(code: string, message: string): StepResult { return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } }; }
