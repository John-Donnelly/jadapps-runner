/**
 * voice-eq: applies a voice-clarity EQ chain — high-pass at 80 Hz to cut
 * rumble, gentle dip at 250 Hz to reduce muddiness, presence boost
 * around 2.5 kHz, air boost at 10 kHz. Each band's gain is configurable.
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

export default async function voiceEq(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "voice-eq requires one audio input");
  const cfg = ctx.inputs ?? {};
  const muddinessCutDb = Math.max(-12, Math.min(0, Number(cfg.muddinessCutDb ?? -3)));
  const presenceBoostDb = Math.max(0, Math.min(12, Number(cfg.presenceBoostDb ?? 3)));
  const airBoostDb = Math.max(0, Math.min(12, Number(cfg.airBoostDb ?? 2)));

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const ext = extname(ref.filename ?? ".mp3") || ".mp3";
  const baseName = (ref.filename ?? "audio").replace(/\.[^.]+$/, "");
  const outRef = `${baseName}-voiced${ext}`;
  const outPath = join(ctx.scratchDir, outRef);

  const filter = [
    "highpass=f=80",
    `equalizer=f=250:t=q:w=2:g=${muddinessCutDb}`,
    `equalizer=f=2500:t=q:w=2:g=${presenceBoostDb}`,
    `equalizer=f=10000:t=q:w=2:g=${airBoostDb}`,
  ].join(",");

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
    outputs: { muddinessCutDb, presenceBoostDb, airBoostDb },
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
