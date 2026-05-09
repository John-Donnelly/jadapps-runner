/**
 * true-peak-limiter: applies a true-peak look-ahead limiter via ffmpeg's
 * alimiter filter so no inter-sample peak exceeds the configured ceiling
 * (default -1 dBTP). Useful before lossy encoders that can introduce peak
 * overshoot.
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

export default async function truePeakLimiter(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "true-peak-limiter requires one audio input");
  const cfg = ctx.inputs ?? {};
  const ceilingDb = Math.max(-12, Math.min(0, Number(cfg.ceilingDb ?? -1)));
  const release = Math.max(1, Math.min(9000, Number(cfg.release ?? 50)));

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const ext = extname(ref.filename ?? ".mp3") || ".mp3";
  const baseName = (ref.filename ?? "audio").replace(/\.[^.]+$/, "");
  const outRef = `${baseName}-limited${ext}`;
  const outPath = join(ctx.scratchDir, outRef);

  // alimiter level uses linear units. 0 dBFS = 1.0; -1 dBTP ≈ 0.891.
  const limit = Math.pow(10, ceilingDb / 20);
  const filter = `alimiter=limit=${limit.toFixed(6)}:level=disabled:release=${release}`;

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
    outputs: { ceilingDb, release },
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
