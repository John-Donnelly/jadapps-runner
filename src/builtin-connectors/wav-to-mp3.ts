/**
 * wav-to-mp3: encodes WAV (or any decodable audio) to MP3 via ffmpeg's
 * libmp3lame. Configure via `bitrate` (kbps, default 192) or `vbr`
 * (quality 0-9, lower = better; takes precedence over bitrate when set).
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

export default async function wavToMp3(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "wav-to-mp3 requires one audio input");

  const cfg = ctx.inputs ?? {};
  const bitrate = Math.max(32, Math.min(320, Math.floor(Number(cfg.bitrate ?? 192))));
  const vbr = cfg.vbr != null ? Math.max(0, Math.min(9, Math.floor(Number(cfg.vbr)))) : null;

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const baseName = (ref.filename ?? "audio").replace(/\.[^.]+$/, "");
  const outRef = `${baseName}.mp3`;
  const outPath = join(ctx.scratchDir, outRef);

  const args = ["-y", "-i", inPath, "-codec:a", "libmp3lame"];
  if (vbr != null) args.push("-q:a", String(vbr));
  else args.push("-b:a", `${bitrate}k`);
  args.push(outPath);

  try {
    await execFileAsync("ffmpeg", args);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return errorResult("driver_missing", "ffmpeg not found on PATH");
    return errorResult("ffmpeg_error", `ffmpeg failed: ${(err as { message: string }).message}`);
  }

  ctx.emitProgress(totalIn);
  const outBytes = sizeOrFallback(outPath, 0);

  return {
    ok: true,
    outputs: { encoder: "libmp3lame", bitrate: vbr == null ? bitrate : null, vbr },
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
