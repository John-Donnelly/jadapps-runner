/**
 * volume-normalizer: peak-normalises audio so the loudest sample lands at
 * the configured peak (default -1 dBFS). Uses ffmpeg's volumedetect to
 * measure the current peak, then volume= filter to scale.
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

export default async function volumeNormalizer(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "volume-normalizer requires one audio input");
  const cfg = ctx.inputs ?? {};
  const targetPeakDb = Math.max(-30, Math.min(0, Number(cfg.targetPeakDb ?? -1)));

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);

  // Measure max_volume via ffmpeg's volumedetect filter.
  let maxVolumeDb = 0;
  try {
    const detect = await execFileAsync("ffmpeg", ["-y", "-i", inPath, "-af", "volumedetect", "-f", "null", "-"]);
    const stderr = (detect as { stderr?: string }).stderr ?? "";
    const match = /max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/.exec(stderr);
    if (match) maxVolumeDb = Number(match[1]);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return errorResult("driver_missing", "ffmpeg not found on PATH");
    // ffmpeg writes volumedetect output to stderr even on success; tolerate non-zero exits if we got a measurement.
    const stderr = (err as { stderr?: string }).stderr ?? "";
    const match = /max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/.exec(stderr);
    if (!match) return errorResult("ffmpeg_error", `volumedetect failed: ${(err as { message: string }).message}`);
    maxVolumeDb = Number(match[1]);
  }

  const gainDb = targetPeakDb - maxVolumeDb;
  const ext = extname(ref.filename ?? ".mp3") || ".mp3";
  const baseName = (ref.filename ?? "audio").replace(/\.[^.]+$/, "");
  const outRef = `${baseName}-normalized${ext}`;
  const outPath = join(ctx.scratchDir, outRef);

  try {
    await execFileAsync("ffmpeg", ["-y", "-i", inPath, "-af", `volume=${gainDb.toFixed(2)}dB`, outPath]);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return errorResult("driver_missing", "ffmpeg not found on PATH");
    return errorResult("ffmpeg_error", `ffmpeg failed: ${(err as { message: string }).message}`);
  }

  ctx.emitProgress(totalIn);
  const outBytes = sizeOrFallback(outPath, 0);
  return {
    ok: true,
    outputs: { targetPeakDb, originalMaxDb: maxVolumeDb, gainAppliedDb: gainDb },
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
