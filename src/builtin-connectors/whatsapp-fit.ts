/**
 * whatsapp-fit: same target-size compression as discord-fit, with
 * WhatsApp's 16 MB attachment cap as the default.
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

export default async function whatsappFit(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "whatsapp-fit requires one audio input");
  const cfg = ctx.inputs ?? {};
  const targetMb = Math.max(1, Math.min(100, Number(cfg.targetMb ?? 16)));

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);

  let durationSec = 0;
  try {
    const probe = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", inPath]);
    durationSec = Number(probe.stdout.trim());
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return errorResult("driver_missing", "ffprobe not found on PATH");
  }
  if (!Number.isFinite(durationSec) || durationSec <= 0) return errorResult("probe_failed", "could not determine duration");

  const targetBytes = targetMb * 1024 * 1024 * 0.95;
  const maxBitrateBps = (targetBytes * 8) / durationSec;
  const candidates = [320, 256, 192, 160, 128, 96, 80, 64, 48, 32];
  const bitrate = candidates.find((b) => b * 1000 <= maxBitrateBps);
  if (!bitrate) return errorResult("size_too_large", `target of ${targetMb}MB unreachable for ${Math.round(durationSec)}s of audio`);

  const baseName = (ref.filename ?? "audio").replace(/\.[^.]+$/, "");
  const outRef = `${baseName}-whatsapp.mp3`;
  const outPath = join(ctx.scratchDir, outRef);

  try {
    await execFileAsync("ffmpeg", ["-y", "-i", inPath, "-codec:a", "libmp3lame", "-b:a", `${bitrate}k`, outPath]);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return errorResult("driver_missing", "ffmpeg not found on PATH");
    return errorResult("ffmpeg_error", `ffmpeg failed: ${(err as { message: string }).message}`);
  }

  ctx.emitProgress(totalIn);
  const outBytes = sizeOrFallback(outPath, 0);
  return {
    ok: true,
    outputs: { targetMb, durationSec, chosenBitrate: bitrate, finalBytes: outBytes },
    fileRefs: [{ ref: outRef, bytes: outBytes, sha256: "", mime: "audio/mpeg", filename: outRef }],
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
