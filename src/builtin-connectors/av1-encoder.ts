/**
 * av1-encoder: re-encodes a video as AV1 via ffmpeg. Prefers libsvtav1
 * (fast, modern) and falls back to libaom-av1 if that codec isn't compiled
 * in. AV1 produces smaller files than H.265 at comparable quality but
 * encodes more slowly.
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

export default async function av1Encoder(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "av1-encoder requires one video input");
  const cfg = ctx.inputs ?? {};
  const crf = Math.max(0, Math.min(63, Math.floor(Number(cfg.crf ?? 30))));
  const speedPreset = Math.max(0, Math.min(13, Math.floor(Number(cfg.speedPreset ?? 8))));

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const baseName = (ref.filename ?? "video").replace(/\.[^.]+$/, "");
  const outRef = `${baseName}-av1.mp4`;
  const outPath = join(ctx.scratchDir, outRef);

  // Try libsvtav1 first; fall back to libaom-av1.
  let usedCodec = "libsvtav1";
  try {
    await execFileAsync("ffmpeg", [
      "-y", "-i", inPath,
      "-c:v", "libsvtav1", "-crf", String(crf), "-preset", String(speedPreset),
      "-c:a", "aac", "-b:a", "192k", outPath,
    ], { maxBuffer: 50 * 1024 * 1024 });
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return errorResult("driver_missing", "ffmpeg not found on PATH");
    usedCodec = "libaom-av1";
    try {
      await execFileAsync("ffmpeg", [
        "-y", "-i", inPath,
        "-c:v", "libaom-av1", "-crf", String(crf), "-cpu-used", String(speedPreset), "-b:v", "0",
        "-c:a", "aac", "-b:a", "192k", outPath,
      ], { maxBuffer: 50 * 1024 * 1024 });
    } catch (err2) {
      return errorResult("ffmpeg_error", `AV1 encode failed (neither libsvtav1 nor libaom-av1 worked): ${(err2 as { message: string }).message}`);
    }
  }

  ctx.emitProgress(totalIn);
  const outBytes = sizeOrFallback(outPath, 0);
  return {
    ok: true,
    outputs: { codec: usedCodec, crf, speedPreset, originalBytes: totalIn, encodedBytes: outBytes },
    fileRefs: [{ ref: outRef, bytes: outBytes, sha256: "", mime: "video/mp4", filename: outRef }],
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
