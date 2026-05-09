/**
 * mp3-to-wav: decodes MP3 to PCM WAV via ffmpeg. Default format 16-bit
 * PCM, 44.1 kHz, stereo — change via `sampleRate`, `channels`, or
 * `sampleFormat` (s16/s24/s32/f32).
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

const SAMPLE_FORMATS = new Map([
  ["s16", "pcm_s16le"],
  ["s24", "pcm_s24le"],
  ["s32", "pcm_s32le"],
  ["f32", "pcm_f32le"],
]);

export default async function mp3ToWav(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "mp3-to-wav requires one MP3 input");

  const cfg = ctx.inputs ?? {};
  const sampleRate = Math.max(8000, Math.min(192000, Math.floor(Number(cfg.sampleRate ?? 44100))));
  const channels = Math.max(1, Math.min(8, Math.floor(Number(cfg.channels ?? 2))));
  const sampleFormat = SAMPLE_FORMATS.get(String(cfg.sampleFormat ?? "s16")) ?? "pcm_s16le";

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const baseName = (ref.filename ?? "audio").replace(/\.mp3$/i, "");
  const outRef = `${baseName}.wav`;
  const outPath = join(ctx.scratchDir, outRef);

  try {
    await execFileAsync("ffmpeg", [
      "-y", "-i", inPath,
      "-acodec", sampleFormat,
      "-ar", String(sampleRate),
      "-ac", String(channels),
      outPath,
    ]);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") {
      return errorResult("driver_missing", "ffmpeg binary not found on PATH");
    }
    return errorResult("ffmpeg_error", `ffmpeg failed: ${(err as { message: string }).message}`);
  }

  ctx.emitProgress(totalIn);
  const outBytes = sizeOrFallback(outPath, 0);

  return {
    ok: true,
    outputs: { sampleRate, channels, sampleFormat },
    fileRefs: [{ ref: outRef, bytes: outBytes, sha256: "", mime: "audio/wav", filename: outRef }],
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
