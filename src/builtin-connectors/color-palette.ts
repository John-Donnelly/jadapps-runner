/**
 * color-palette: extracts the dominant N colours from an input image
 * by quantising to a small palette and counting occurrences.
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

export default async function colorPalette(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "color-palette requires one image input");
  let sharp: typeof import("sharp");
  try { sharp = (await import("sharp")).default as unknown as typeof import("sharp"); }
  catch (err) { return errorResult("driver_missing", `sharp not installed: ${(err as Error).message}`); }
  const cfg = ctx.inputs ?? {};
  const count = Math.max(1, Math.min(64, Number(cfg.count ?? 8)));
  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);
  const factory = sharp as unknown as (b: Buffer) => { resize(s: number, t: number, opts: object): { raw(): { toBuffer(o: { resolveWithObject: boolean }): Promise<{ data: Buffer; info: { width: number; height: number; channels: number } }> } } };
  const { data, info } = await factory(buf).resize(64, 64, { fit: "inside" }).raw().toBuffer({ resolveWithObject: true });
  const buckets = new Map<string, number>();
  for (let i = 0; i < data.length; i += info.channels) {
    const r = (data[i] ?? 0) >> 4 << 4;
    const g = (data[i + 1] ?? 0) >> 4 << 4;
    const b = (data[i + 2] ?? 0) >> 4 << 4;
    const key = `${r},${g},${b}`;
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  const total = [...buckets.values()].reduce((s, n) => s + n, 0);
  const palette = [...buckets.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([k, n]) => {
      const [r, g, b] = k.split(",").map(Number);
      return { hex: `#${(r! << 16 | g! << 8 | b!).toString(16).padStart(6, "0")}`, rgb: [r, g, b], proportion: n / total };
    });
  const json = JSON.stringify({ file: ref.filename ?? ref.ref, palette }, null, 2);
  const outRef = "color-palette.json";
  await writeFile(join(ctx.scratchDir, outRef), json, "utf8");
  return { ok: true, outputs: { paletteSize: palette.length, palette }, fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(json, "utf8"), sha256: "", mime: "application/json", filename: outRef }], bytesProcessed: totalIn, durationMs: Date.now() - start };
}

function sizeOrFallback(path: string, fallback: number): number { try { return statSync(path).size; } catch { return fallback; } }
function errorResult(code: string, message: string): StepResult { return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } }; }
