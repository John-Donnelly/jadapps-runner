/**
 * spectrum-analyzer: renders a PNG spectrogram (frequency over time) of
 * the input audio via ffmpeg's showspectrumpic filter.
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

export default async function spectrumAnalyzer(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "spectrum-analyzer requires one audio input");
  const cfg = ctx.inputs ?? {};
  const width = Math.max(640, Math.min(4096, Math.floor(Number(cfg.width ?? 1920))));
  const height = Math.max(240, Math.min(2048, Math.floor(Number(cfg.height ?? 720))));
  const colorMode = ["intensity", "rainbow", "moreland", "nebulae", "fire"].includes(cfg.colorMode as string) ? cfg.colorMode as string : "intensity";

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const baseName = (ref.filename ?? "audio").replace(/\.[^.]+$/, "");
  const outRef = `${baseName}-spectrum.png`;
  const outPath = join(ctx.scratchDir, outRef);

  try {
    await execFileAsync("ffmpeg", ["-y", "-i", inPath, "-lavfi", `showspectrumpic=s=${width}x${height}:color=${colorMode}`, outPath]);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return errorResult("driver_missing", "ffmpeg not found on PATH");
    return errorResult("ffmpeg_error", `ffmpeg failed: ${(err as { message: string }).message}`);
  }

  ctx.emitProgress(totalIn);
  const outBytes = sizeOrFallback(outPath, 0);
  return {
    ok: true,
    outputs: { width, height, colorMode },
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
