/**
 * pitch-shifter: shifts the pitch by N semitones without changing duration.
 * Uses ffmpeg's rubberband filter when available, falls back to the
 * asetrate+atempo combo (cruder, may introduce artefacts).
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

export default async function pitchShifter(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "pitch-shifter requires one audio input");
  const cfg = ctx.inputs ?? {};
  const semitones = Math.max(-24, Math.min(24, Number(cfg.semitones ?? 0)));
  if (semitones === 0) return errorResult("invalid_config", "semitones must be non-zero");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const ext = extname(ref.filename ?? ".mp3") || ".mp3";
  const baseName = (ref.filename ?? "audio").replace(/\.[^.]+$/, "");
  const outRef = `${baseName}-pitched${ext}`;
  const outPath = join(ctx.scratchDir, outRef);

  // Try rubberband first (best quality), fall back to asetrate+atempo.
  const rbFilter = `rubberband=pitch=${Math.pow(2, semitones / 12).toFixed(6)}`;
  let usedFallback = false;
  try {
    await execFileAsync("ffmpeg", ["-y", "-i", inPath, "-af", rbFilter, outPath]);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return errorResult("driver_missing", "ffmpeg not found on PATH");
    // Fall back to asetrate+atempo when rubberband isn't compiled in.
    usedFallback = true;
    const ratio = Math.pow(2, semitones / 12);
    const fallbackFilter = `asetrate=44100*${ratio.toFixed(6)},aresample=44100,atempo=${(1 / ratio).toFixed(6)}`;
    try {
      await execFileAsync("ffmpeg", ["-y", "-i", inPath, "-af", fallbackFilter, outPath]);
    } catch (err2) {
      return errorResult("ffmpeg_error", `ffmpeg pitch-shift failed: ${(err2 as { message: string }).message}`);
    }
  }

  ctx.emitProgress(totalIn);
  const outBytes = sizeOrFallback(outPath, 0);
  return {
    ok: true,
    outputs: { semitones, usedFallback },
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
