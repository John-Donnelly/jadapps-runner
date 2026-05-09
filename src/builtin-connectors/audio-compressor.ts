/**
 * audio-compressor: applies a single-band dynamic compressor via ffmpeg's
 * acompressor filter. Defaults: 4:1 ratio, -18 dB threshold, 250 ms
 * release. Reduces dynamic range without crushing transients.
 */

import { statSync } from "node:fs";
import { join, extname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { StepResult, FileRef } from "../types.js";

const execFileAsync = promisify(execFile);

interface ToolContext {
  toolId: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRef[];
  scratchDir: string;
  emitProgress(bytes: number): void;
}

export default async function audioCompressor(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "audio-compressor requires one audio input");
  const cfg = ctx.inputs ?? {};
  const ratio = Math.max(1, Math.min(20, Number(cfg.ratio ?? 4)));
  const threshold = Math.max(-60, Math.min(0, Number(cfg.threshold ?? -18)));
  const attack = Math.max(0.01, Math.min(2000, Number(cfg.attack ?? 20)));
  const release = Math.max(0.01, Math.min(9000, Number(cfg.release ?? 250)));
  const makeup = Math.max(1, Math.min(64, Number(cfg.makeup ?? 1)));

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const ext = extname(ref.filename ?? ".mp3") || ".mp3";
  const baseName = (ref.filename ?? "audio").replace(/\.[^.]+$/, "");
  const outRef = `${baseName}-compressed${ext}`;
  const outPath = join(ctx.scratchDir, outRef);

  // ffmpeg threshold expects a linear value (0..1). Convert from dB.
  const thresholdLinear = Math.pow(10, threshold / 20);
  const filter = `acompressor=ratio=${ratio}:threshold=${thresholdLinear.toFixed(6)}:attack=${attack}:release=${release}:makeup=${makeup}`;

  try {
    await execFileAsync("ffmpeg", ["-y", "-i", inPath, "-af", filter, outPath]);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return errorResult("driver_missing", "ffmpeg not found on PATH");
    return errorResult("ffmpeg_error", `ffmpeg failed: ${(err as { message: string }).message}`);
  }

  ctx.emitProgress(totalIn);
  const outBytes = sizeOrFallback(outPath, 0);
  return {
    ok: true,
    outputs: { ratio, threshold, attack, release, makeup },
    fileRefs: [{ ref: outRef, bytes: outBytes, sha256: "", mime: ref.mime || "audio/mpeg", filename: outRef }],
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
