/**
 * color-picker: returns the RGB(A) value at a specific (x, y) pixel
 * coordinate of the input image.
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

export default async function colorPicker(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "color-picker requires one image input");
  let sharp: typeof import("sharp");
  try { sharp = (await import("sharp")).default as unknown as typeof import("sharp"); }
  catch (err) { return errorResult("driver_missing", `sharp not installed: ${(err as Error).message}`); }
  const cfg = ctx.inputs ?? {};
  const x = Math.max(0, Number(cfg.x ?? 0));
  const y = Math.max(0, Number(cfg.y ?? 0));
  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);
  const factory = sharp as unknown as (b: Buffer) => { raw(): { toBuffer(o: { resolveWithObject: boolean }): Promise<{ data: Buffer; info: { width: number; height: number; channels: number } }> } };
  const { data, info } = await factory(buf).raw().toBuffer({ resolveWithObject: true });
  const xi = Math.min(x, info.width - 1);
  const yi = Math.min(y, info.height - 1);
  const idx = (yi * info.width + xi) * info.channels;
  const r = data[idx] ?? 0, g = data[idx + 1] ?? 0, b = data[idx + 2] ?? 0;
  const a = info.channels === 4 ? data[idx + 3] ?? 255 : 255;
  const hex = `#${(r << 16 | g << 8 | b).toString(16).padStart(6, "0")}`;
  const json = JSON.stringify({ x: xi, y: yi, r, g, b, a, hex }, null, 2);
  const outRef = "color-picker.json";
  await writeFile(join(ctx.scratchDir, outRef), json, "utf8");
  return { ok: true, outputs: { x: xi, y: yi, r, g, b, a, hex }, fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(json, "utf8"), sha256: "", mime: "application/json", filename: outRef }], bytesProcessed: totalIn, durationMs: Date.now() - start };
}

function sizeOrFallback(path: string, fallback: number): number { try { return statSync(path).size; } catch { return fallback; } }
function errorResult(code: string, message: string): StepResult { return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } }; }
