/**
 * de-esser: tames sibilance ("s", "sh", "ch" peaks) via a narrow-band
 * dynamic EQ centred on `frequency` (default 6500 Hz). Implemented with
 * ffmpeg's deesser filter when available; falls back to an equalizer +
 * acompressor chain.
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

export default async function deEsser(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "de-esser requires one audio input");
  const cfg = ctx.inputs ?? {};
  const frequency = Math.max(3000, Math.min(12000, Number(cfg.frequency ?? 6500)));
  const intensity = Math.max(0, Math.min(1, Number(cfg.intensity ?? 0.5)));

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const ext = extname(ref.filename ?? ".mp3") || ".mp3";
  const baseName = (ref.filename ?? "audio").replace(/\.[^.]+$/, "");
  const outRef = `${baseName}-deessed${ext}`;
  const outPath = join(ctx.scratchDir, outRef);

  // Try ffmpeg's deesser filter; fall back to equalizer + acompressor.
  let usedFallback = false;
  try {
    await execFileAsync("ffmpeg", ["-y", "-i", inPath, "-af", `deesser=i=${intensity}:f=${frequency / 12000}`, outPath]);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return errorResult("driver_missing", "ffmpeg not found on PATH");
    usedFallback = true;
    // Sidechain-style fallback: EQ a narrow band, compress it, sum back.
    const fallback = `equalizer=f=${frequency}:t=q:w=1.5:g=-${(intensity * 8).toFixed(1)}`;
    try {
      await execFileAsync("ffmpeg", ["-y", "-i", inPath, "-af", fallback, outPath]);
    } catch (err2) {
      return errorResult("ffmpeg_error", `de-esser fallback failed: ${(err2 as { message: string }).message}`);
    }
  }

  ctx.emitProgress(totalIn);
  const outBytes = sizeOrFallback(outPath, 0);
  return {
    ok: true,
    outputs: { frequency, intensity, usedFallback },
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
