/**
 * aspect-ratio-cropper: crops an image to a specific aspect ratio
 * (e.g. 1:1, 16:9), centring on the source.
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

export default async function aspectRatioCropper(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "aspect-ratio-cropper requires one image input");
  let sharp: typeof import("sharp");
  try { sharp = (await import("sharp")).default as unknown as typeof import("sharp"); }
  catch (err) { return errorResult("driver_missing", `sharp not installed: ${(err as Error).message}`); }
  const cfg = ctx.inputs ?? {};
  const ratio = String(cfg.ratio ?? "1:1");
  const m = /^(\d+):(\d+)$/.exec(ratio);
  if (!m) return errorResult("invalid_input", "ratio must be in form 'W:H'");
  const ratioNum = Number(m[1]) / Number(m[2]);
  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);
  const factory = sharp as unknown as (b: Buffer) => { metadata(): Promise<{ width?: number; height?: number }>; extract(o: { left: number; top: number; width: number; height: number }): { toBuffer(): Promise<Buffer> } };
  const meta = await factory(buf).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  let cropW = w, cropH = Math.round(w / ratioNum);
  if (cropH > h) { cropH = h; cropW = Math.round(h * ratioNum); }
  const left = Math.round((w - cropW) / 2);
  const top = Math.round((h - cropH) / 2);
  const out = await factory(buf).extract({ left, top, width: cropW, height: cropH }).toBuffer();
  const outRef = (ref.filename ?? ref.ref).replace(/(\.[^.]+)$/, `.${ratio.replace(":", "x")}$1`);
  await writeFile(join(ctx.scratchDir, outRef), out);
  return { ok: true, outputs: { ratio, cropWidth: cropW, cropHeight: cropH, sourceWidth: w, sourceHeight: h }, fileRefs: [{ ref: outRef, bytes: out.length, sha256: "", mime: ref.mime, filename: outRef }], bytesProcessed: totalIn, durationMs: Date.now() - start };
}

function sizeOrFallback(path: string, fallback: number): number { try { return statSync(path).size; } catch { return fallback; } }
function errorResult(code: string, message: string): StepResult { return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } }; }
