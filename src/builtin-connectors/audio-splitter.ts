/**
 * audio-splitter: splits an audio file into N equal-duration segments
 * (`segmentCount`) or by a fixed segment length (`segmentSeconds`). Uses
 * ffmpeg's segment muxer.
 */

import { readdirSync, statSync } from "node:fs";
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

export default async function audioSplitter(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "audio-splitter requires one audio input");
  const cfg = ctx.inputs ?? {};
  const segmentSeconds = cfg.segmentSeconds != null ? Math.max(1, Math.floor(Number(cfg.segmentSeconds))) : null;
  const segmentCount = cfg.segmentCount != null ? Math.max(1, Math.floor(Number(cfg.segmentCount))) : null;
  if (segmentSeconds == null && segmentCount == null) {
    return errorResult("invalid_config", "either segmentSeconds or segmentCount is required");
  }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const baseName = (ref.filename ?? "audio").replace(/\.[^.]+$/, "");

  let actualSeconds = segmentSeconds;
  if (actualSeconds == null && segmentCount != null) {
    try {
      const probe = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", inPath]);
      const total = Number(probe.stdout.trim());
      if (Number.isFinite(total) && total > 0) actualSeconds = Math.ceil(total / segmentCount);
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return errorResult("driver_missing", "ffprobe not found on PATH");
    }
  }
  if (actualSeconds == null) return errorResult("invalid_config", "could not determine segment length");

  const outPattern = join(ctx.scratchDir, `${baseName}-segment-%03d.mp3`);
  try {
    await execFileAsync("ffmpeg", ["-y", "-i", inPath, "-f", "segment", "-segment_time", String(actualSeconds), "-c:a", "libmp3lame", "-b:a", "192k", outPattern]);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return errorResult("driver_missing", "ffmpeg not found on PATH");
    return errorResult("ffmpeg_error", `ffmpeg failed: ${(err as { message: string }).message}`);
  }
  ctx.emitProgress(totalIn);

  const segmentRefs: FileRef[] = readdirSync(ctx.scratchDir)
    .filter((f) => f.startsWith(`${baseName}-segment-`) && f.endsWith(".mp3"))
    .sort()
    .map((f) => ({ ref: f, bytes: sizeOrFallback(join(ctx.scratchDir, f), 0), sha256: "", mime: "audio/mpeg", filename: f }));

  return {
    ok: true,
    outputs: { segmentCount: segmentRefs.length, segmentSeconds: actualSeconds },
    fileRefs: segmentRefs,
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
