/**
 * bitrate-changer: re-encodes audio at a new bitrate. Output codec matches
 * the input file extension when possible (mp3, ogg, opus, m4a/aac).
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

const CODEC_FOR_EXT: Record<string, { codec: string; mime: string }> = {
  ".mp3": { codec: "libmp3lame", mime: "audio/mpeg" },
  ".m4a": { codec: "aac", mime: "audio/mp4" },
  ".aac": { codec: "aac", mime: "audio/aac" },
  ".ogg": { codec: "libvorbis", mime: "audio/ogg" },
  ".opus": { codec: "libopus", mime: "audio/opus" },
};

export default async function bitrateChanger(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "bitrate-changer requires one audio input");
  const cfg = ctx.inputs ?? {};
  const bitrate = Math.max(8, Math.min(320, Math.floor(Number(cfg.bitrate ?? 128))));

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const ext = (extname(ref.filename ?? ".mp3") || ".mp3").toLowerCase();
  const codec = CODEC_FOR_EXT[ext] ?? CODEC_FOR_EXT[".mp3"];
  if (!codec) return errorResult("invalid_config", `unsupported extension: ${ext}`);
  const baseName = (ref.filename ?? "audio").replace(/\.[^.]+$/, "");
  const outRef = `${baseName}-${bitrate}k${ext}`;
  const outPath = join(ctx.scratchDir, outRef);

  try {
    await execFileAsync("ffmpeg", ["-y", "-i", inPath, "-codec:a", codec.codec, "-b:a", `${bitrate}k`, outPath]);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return errorResult("driver_missing", "ffmpeg not found on PATH");
    return errorResult("ffmpeg_error", `ffmpeg failed: ${(err as { message: string }).message}`);
  }

  ctx.emitProgress(totalIn);
  const outBytes = sizeOrFallback(outPath, 0);
  return {
    ok: true,
    outputs: { bitrate, codec: codec.codec },
    fileRefs: [{ ref: outRef, bytes: outBytes, sha256: "", mime: codec.mime, filename: outRef }],
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
