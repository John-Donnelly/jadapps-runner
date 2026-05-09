/**
 * fade-in-out: applies linear fade-in and/or fade-out via ffmpeg's afade
 * filter. `fadeInSeconds` and `fadeOutSeconds` default to 2 each; pass 0
 * to disable a side. Requires ffprobe to determine duration for the fade-out
 * start.
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

export default async function fadeInOut(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "fade-in-out requires one audio input");
  const cfg = ctx.inputs ?? {};
  const fadeIn = Math.max(0, Math.min(60, Number(cfg.fadeInSeconds ?? 2)));
  const fadeOut = Math.max(0, Math.min(60, Number(cfg.fadeOutSeconds ?? 2)));

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);

  let duration = 0;
  try {
    const probe = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", inPath]);
    duration = Number(probe.stdout.trim());
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return errorResult("driver_missing", "ffprobe not found on PATH");
  }
  if (!Number.isFinite(duration) || duration <= 0) return errorResult("probe_failed", "could not determine audio duration");

  const filters: string[] = [];
  if (fadeIn > 0) filters.push(`afade=t=in:st=0:d=${fadeIn}`);
  if (fadeOut > 0) filters.push(`afade=t=out:st=${Math.max(0, duration - fadeOut)}:d=${fadeOut}`);
  if (filters.length === 0) return errorResult("invalid_config", "at least one of fadeInSeconds or fadeOutSeconds must be > 0");

  const ext = extname(ref.filename ?? ".mp3") || ".mp3";
  const baseName = (ref.filename ?? "audio").replace(/\.[^.]+$/, "");
  const outRef = `${baseName}-faded${ext}`;
  const outPath = join(ctx.scratchDir, outRef);

  try {
    await execFileAsync("ffmpeg", ["-y", "-i", inPath, "-af", filters.join(","), outPath]);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return errorResult("driver_missing", "ffmpeg not found on PATH");
    return errorResult("ffmpeg_error", `ffmpeg failed: ${(err as { message: string }).message}`);
  }

  ctx.emitProgress(totalIn);
  const outBytes = sizeOrFallback(outPath, 0);
  return {
    ok: true,
    outputs: { fadeIn, fadeOut, duration },
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
