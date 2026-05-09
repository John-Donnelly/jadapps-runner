/**
 * time-stretcher: changes audio duration without altering pitch. `factor`
 * 0.5 plays at 2x speed (half duration); 2.0 plays at half speed (double
 * duration). Uses ffmpeg's atempo filter, which supports 0.5..100 per
 * stage; values outside the range are chained.
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

export default async function timeStretcher(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "time-stretcher requires one audio input");
  const cfg = ctx.inputs ?? {};
  const factor = Math.max(0.05, Math.min(100, Number(cfg.factor ?? 1)));
  if (factor === 1) return errorResult("invalid_config", "factor must differ from 1");

  // ffmpeg atempo per-instance is restricted to [0.5, 100]. tempo = 1/factor:
  // a factor of 2 (slower) needs atempo=0.5. Chain instances if the speed
  // change overflows a single atempo stage.
  const tempo = 1 / factor;
  const stages: number[] = [];
  let remaining = tempo;
  while (remaining < 0.5) { stages.push(0.5); remaining /= 0.5; }
  while (remaining > 100) { stages.push(100); remaining /= 100; }
  stages.push(remaining);
  const filter = stages.map((s) => `atempo=${s.toFixed(6)}`).join(",");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const ext = extname(ref.filename ?? ".mp3") || ".mp3";
  const baseName = (ref.filename ?? "audio").replace(/\.[^.]+$/, "");
  const outRef = `${baseName}-stretched${ext}`;
  const outPath = join(ctx.scratchDir, outRef);

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
    outputs: { factor, atempoStages: stages.length },
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
