/**
 * ico-generator: builds a multi-resolution ICO container with embedded
 * PNG payloads (Vista-style ICO).
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

const DEFAULT_SIZES = [16, 32, 48, 64, 128, 256];

export default async function icoGenerator(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "ico-generator requires one image input");
  let sharp: typeof import("sharp");
  try { sharp = (await import("sharp")).default as unknown as typeof import("sharp"); }
  catch (err) { return errorResult("driver_missing", `sharp not installed: ${(err as Error).message}`); }
  const cfg = ctx.inputs ?? {};
  const sizes: number[] = Array.isArray(cfg.sizes) ? cfg.sizes.map(Number).filter((n) => n > 0 && n <= 256) : DEFAULT_SIZES;
  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);
  const factory = sharp as unknown as (b: Buffer) => { resize(s: number, t: number): { png(): { toBuffer(): Promise<Buffer> } } };

  const pngs: { size: number; data: Buffer }[] = [];
  for (const s of sizes) pngs.push({ size: s, data: await factory(buf).resize(s, s).png().toBuffer() });

  // ICONDIR: 6 bytes; ICONDIRENTRY: 16 bytes per image; then PNG payloads.
  const headerSize = 6;
  const dirSize = 16 * pngs.length;
  let dataOffset = headerSize + dirSize;
  const totalSize = dataOffset + pngs.reduce((s, p) => s + p.data.length, 0);
  const ico = Buffer.alloc(totalSize);
  ico.writeUInt16LE(0, 0); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(pngs.length, 4);
  let dirOff = headerSize;
  for (const p of pngs) {
    ico.writeUInt8(p.size === 256 ? 0 : p.size, dirOff);
    ico.writeUInt8(p.size === 256 ? 0 : p.size, dirOff + 1);
    ico.writeUInt8(0, dirOff + 2); ico.writeUInt8(0, dirOff + 3);
    ico.writeUInt16LE(1, dirOff + 4); ico.writeUInt16LE(32, dirOff + 6);
    ico.writeUInt32LE(p.data.length, dirOff + 8);
    ico.writeUInt32LE(dataOffset, dirOff + 12);
    p.data.copy(ico, dataOffset);
    dataOffset += p.data.length;
    dirOff += 16;
  }
  const outRef = "favicon.ico";
  await writeFile(join(ctx.scratchDir, outRef), ico);
  return { ok: true, outputs: { sizes, icoBytes: ico.length }, fileRefs: [{ ref: outRef, bytes: ico.length, sha256: "", mime: "image/x-icon", filename: outRef }], bytesProcessed: totalIn, durationMs: Date.now() - start };
}

function sizeOrFallback(path: string, fallback: number): number { try { return statSync(path).size; } catch { return fallback; } }
function errorResult(code: string, message: string): StepResult { return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } }; }
