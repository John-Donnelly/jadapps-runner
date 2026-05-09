/**
 * audio-trimmer: cuts an audio file to the configured time window. `start`
 * and `end` accept HH:MM:SS or seconds. If only `start` and `duration` are
 * supplied, ffmpeg trims relative to start.
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

export default async function audioTrimmer(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "audio-trimmer requires one audio input");
  const cfg = ctx.inputs ?? {};
  const startTime = cfg.start != null ? String(cfg.start) : "0";
  const endTime = cfg.end != null ? String(cfg.end) : null;
  const duration = cfg.duration != null ? String(cfg.duration) : null;
  if (endTime == null && duration == null) return errorResult("invalid_config", "either end or duration is required");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const ext = extname(ref.filename ?? ".mp3") || ".mp3";
  const baseName = (ref.filename ?? "audio").replace(/\.[^.]+$/, "");
  const outRef = `${baseName}-trimmed${ext}`;
  const outPath = join(ctx.scratchDir, outRef);

  const args = ["-y", "-i", inPath, "-ss", startTime];
  if (endTime != null) args.push("-to", endTime);
  if (duration != null) args.push("-t", duration);
  args.push("-c", "copy", outPath);

  try {
    await execFileAsync("ffmpeg", args);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return errorResult("driver_missing", "ffmpeg not found on PATH");
    return errorResult("ffmpeg_error", `ffmpeg failed: ${(err as { message: string }).message}`);
  }

  ctx.emitProgress(totalIn);
  const outBytes = sizeOrFallback(outPath, 0);
  return {
    ok: true,
    outputs: { startTime, endTime, duration },
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
