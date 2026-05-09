/**
 * waveform-generator: renders a PNG waveform image via ffmpeg's
 * showwavespic filter. Useful as a thumbnail for podcasts or audio embeds.
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

export default async function waveformGenerator(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "waveform-generator requires one audio input");
  const cfg = ctx.inputs ?? {};
  const width = Math.max(320, Math.min(4096, Math.floor(Number(cfg.width ?? 1600))));
  const height = Math.max(120, Math.min(1024, Math.floor(Number(cfg.height ?? 240))));
  const colorHex = String(cfg.color ?? "0x4F46E5").replace(/^#/, "0x");
  const background = String(cfg.background ?? "0xFFFFFF").replace(/^#/, "0x");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const baseName = (ref.filename ?? "audio").replace(/\.[^.]+$/, "");
  const outRef = `${baseName}-waveform.png`;
  const outPath = join(ctx.scratchDir, outRef);

  const filter = `showwavespic=s=${width}x${height}:colors=${colorHex}|${colorHex}:split_channels=1`;
  const fullFilter = `color=c=${background}:s=${width}x${height}[bg];[0:a]${filter}[fg];[bg][fg]overlay=format=auto`;

  try {
    await execFileAsync("ffmpeg", ["-y", "-i", inPath, "-filter_complex", fullFilter, "-frames:v", "1", outPath]);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return errorResult("driver_missing", "ffmpeg not found on PATH");
    return errorResult("ffmpeg_error", `ffmpeg failed: ${(err as { message: string }).message}`);
  }

  ctx.emitProgress(totalIn);
  const outBytes = sizeOrFallback(outPath, 0);
  return {
    ok: true,
    outputs: { width, height, color: colorHex, background },
    fileRefs: [{ ref: outRef, bytes: outBytes, sha256: "", mime: "image/png", filename: outRef }],
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
