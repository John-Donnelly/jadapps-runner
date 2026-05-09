/**
 * silence-stripper: removes silence at the start and end of the audio
 * (and optionally between) via ffmpeg's silenceremove filter. Threshold
 * is in dB below peak; default -40 dB.
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

export default async function silenceStripper(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "silence-stripper requires one audio input");
  const cfg = ctx.inputs ?? {};
  const thresholdDb = Math.max(-80, Math.min(-10, Number(cfg.thresholdDb ?? -40)));
  const minSilenceMs = Math.max(50, Math.min(10000, Number(cfg.minSilenceMs ?? 500)));
  const stripInternal = cfg.stripInternal === true;

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const ext = extname(ref.filename ?? ".mp3") || ".mp3";
  const baseName = (ref.filename ?? "audio").replace(/\.[^.]+$/, "");
  const outRef = `${baseName}-stripped${ext}`;
  const outPath = join(ctx.scratchDir, outRef);

  // start_periods=1 strips leading silence; stop_periods=-1 keeps stripping
  // throughout when stripInternal is set, otherwise stop_periods=1 (trailing only).
  const stopPeriods = stripInternal ? -1 : 1;
  const minSilenceSec = (minSilenceMs / 1000).toFixed(3);
  const filter = `silenceremove=start_periods=1:start_duration=${minSilenceSec}:start_threshold=${thresholdDb}dB:stop_periods=${stopPeriods}:stop_duration=${minSilenceSec}:stop_threshold=${thresholdDb}dB`;

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
    outputs: { thresholdDb, minSilenceMs, stripInternal },
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
