/**
 * podcast-master: opinionated podcast-mastering chain in a single ffmpeg
 * pass — high-pass at 80 Hz, gentle voice EQ, afftdn denoise, acompressor
 * (3:1 / -22 dB), loudnorm to -16 LUFS, and a true-peak alimiter at
 * -1.5 dBTP. Single-pass for speed; pair with loudness-normalizer for
 * a stricter two-pass result.
 */

import { statSync } from "node:fs";
import { join } from "node:path";
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

export default async function podcastMaster(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "podcast-master requires one audio input");
  const cfg = ctx.inputs ?? {};
  const targetLufs = Math.max(-30, Math.min(-12, Number(cfg.targetLufs ?? -16)));
  const denoiseDb = Math.max(0, Math.min(30, Number(cfg.denoiseDb ?? 8)));
  const bitrate = Math.max(64, Math.min(320, Math.floor(Number(cfg.bitrate ?? 192))));

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const baseName = (ref.filename ?? "audio").replace(/\.[^.]+$/, "");
  const outRef = `${baseName}-mastered.mp3`;
  const outPath = join(ctx.scratchDir, outRef);

  const filter = [
    "highpass=f=80",
    `afftdn=nr=${denoiseDb}`,
    "equalizer=f=250:t=q:w=2:g=-2",
    "equalizer=f=2500:t=q:w=2:g=2",
    "equalizer=f=10000:t=q:w=2:g=1.5",
    "acompressor=ratio=3:threshold=0.079:attack=10:release=200:makeup=2",
    `loudnorm=I=${targetLufs}:TP=-1.5:LRA=7`,
    "alimiter=limit=0.891:level=disabled:release=50",
  ].join(",");

  try {
    await execFileAsync("ffmpeg", ["-y", "-i", inPath, "-af", filter, "-codec:a", "libmp3lame", "-b:a", `${bitrate}k`, outPath]);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return errorResult("driver_missing", "ffmpeg not found on PATH");
    return errorResult("ffmpeg_error", `ffmpeg failed: ${(err as { message: string }).message}`);
  }

  ctx.emitProgress(totalIn);
  const outBytes = sizeOrFallback(outPath, 0);
  return {
    ok: true,
    outputs: { targetLufs, denoiseDb, bitrate, finalBytes: outBytes },
    fileRefs: [{ ref: outRef, bytes: outBytes, sha256: "", mime: "audio/mpeg", filename: outRef }],
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
