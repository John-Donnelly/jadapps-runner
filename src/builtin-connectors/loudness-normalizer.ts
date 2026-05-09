/**
 * loudness-normalizer: EBU R128 two-pass loudness normalisation via
 * ffmpeg's loudnorm filter. Targets `targetLufs` integrated loudness
 * (Spotify -14, Apple Podcasts -16, EBU broadcast -23) with `truePeakDb`
 * ceiling and `lra` loudness range.
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

export default async function loudnessNormalizer(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "loudness-normalizer requires one audio input");
  const cfg = ctx.inputs ?? {};
  const targetLufs = Math.max(-30, Math.min(-5, Number(cfg.targetLufs ?? -16)));
  const truePeakDb = Math.max(-9, Math.min(0, Number(cfg.truePeakDb ?? -1.5)));
  const lra = Math.max(1, Math.min(20, Number(cfg.lra ?? 11)));

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);

  const filterFirstPass = `loudnorm=I=${targetLufs}:TP=${truePeakDb}:LRA=${lra}:print_format=json`;
  let measured = { input_i: "", input_lra: "", input_tp: "", input_thresh: "", target_offset: "" };
  try {
    const r = await execFileAsync("ffmpeg", ["-y", "-i", inPath, "-af", filterFirstPass, "-f", "null", "-"]);
    const stderr = (r as { stderr?: string }).stderr ?? "";
    const jsonMatch = stderr.match(/\{[\s\S]*?"target_offset"[\s\S]*?\}/);
    if (jsonMatch) measured = JSON.parse(jsonMatch[0]);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return errorResult("driver_missing", "ffmpeg not found on PATH");
    const stderr = (err as { stderr?: string }).stderr ?? "";
    const jsonMatch = stderr.match(/\{[\s\S]*?"target_offset"[\s\S]*?\}/);
    if (!jsonMatch) return errorResult("ffmpeg_error", `loudnorm pass 1 failed: ${(err as { message: string }).message}`);
    measured = JSON.parse(jsonMatch[0]);
  }

  const filterSecondPass = `loudnorm=I=${targetLufs}:TP=${truePeakDb}:LRA=${lra}:` +
    `measured_I=${measured.input_i}:measured_LRA=${measured.input_lra}:` +
    `measured_TP=${measured.input_tp}:measured_thresh=${measured.input_thresh}:` +
    `offset=${measured.target_offset}:linear=true:print_format=summary`;

  const ext = extname(ref.filename ?? ".mp3") || ".mp3";
  const baseName = (ref.filename ?? "audio").replace(/\.[^.]+$/, "");
  const outRef = `${baseName}-normalized${ext}`;
  const outPath = join(ctx.scratchDir, outRef);

  try {
    await execFileAsync("ffmpeg", ["-y", "-i", inPath, "-af", filterSecondPass, outPath]);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return errorResult("driver_missing", "ffmpeg not found on PATH");
    return errorResult("ffmpeg_error", `loudnorm pass 2 failed: ${(err as { message: string }).message}`);
  }

  ctx.emitProgress(totalIn);
  const outBytes = sizeOrFallback(outPath, 0);
  return {
    ok: true,
    outputs: { targetLufs, truePeakDb, lra, measured },
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
