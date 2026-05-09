/**
 * channel-splitter: splits a stereo file into separate left/right WAVs via
 * ffmpeg's channelsplit filter. Multi-channel inputs (5.1, 7.1) split into
 * one file per source channel.
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

export default async function channelSplitter(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "channel-splitter requires one audio input");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);

  // Probe channel count
  let channelCount = 2;
  try {
    const probe = await execFileAsync("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=channels", "-of", "default=nw=1:nk=1", inPath]);
    const c = parseInt(probe.stdout.trim(), 10);
    if (Number.isFinite(c) && c > 0) channelCount = c;
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return errorResult("driver_missing", "ffprobe not found on PATH");
  }
  if (channelCount === 1) return errorResult("invalid_input", "input is mono — nothing to split");

  const baseName = (ref.filename ?? "audio").replace(/\.[^.]+$/, "");
  const outputArgs: string[] = ["-y", "-i", inPath, "-filter_complex", `channelsplit=channel_layout=${channelCount === 2 ? "stereo" : channelCount + "c"}` + Array.from({ length: channelCount }, (_, i) => `[ch${i}]`).join("")];
  const outRefs: FileRef[] = [];
  for (let i = 0; i < channelCount; i++) {
    const labelMap = channelCount === 2 ? ["L", "R"] : Array.from({ length: channelCount }, (_, n) => `ch${n}`);
    const label = labelMap[i] ?? `ch${i}`;
    const outRef = `${baseName}-${label}.wav`;
    outputArgs.push("-map", `[ch${i}]`, join(ctx.scratchDir, outRef));
    outRefs.push({ ref: outRef, bytes: 0, sha256: "", mime: "audio/wav", filename: outRef });
  }

  try {
    await execFileAsync("ffmpeg", outputArgs);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return errorResult("driver_missing", "ffmpeg not found on PATH");
    return errorResult("ffmpeg_error", `ffmpeg failed: ${(err as { message: string }).message}`);
  }

  ctx.emitProgress(totalIn);
  for (const ref of outRefs) ref.bytes = sizeOrFallback(join(ctx.scratchDir, ref.ref), 0);
  return {
    ok: true,
    outputs: { channelCount },
    fileRefs: outRefs,
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
