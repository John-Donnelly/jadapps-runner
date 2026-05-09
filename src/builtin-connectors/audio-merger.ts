/**
 * audio-merger: concatenates multiple audio inputs into a single MP3. Uses
 * ffmpeg's concat demuxer (lossless re-mux when codecs match; transcodes
 * otherwise). Output codec: libmp3lame at 192kbps unless `bitrate` is set.
 */

import { writeFile } from "node:fs/promises";
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

export default async function audioMerger(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  if (!Array.isArray(ctx.fileRefs) || ctx.fileRefs.length < 2) {
    return errorResult("missing_input", "audio-merger requires at least two audio inputs");
  }
  const cfg = ctx.inputs ?? {};
  const bitrate = Math.max(32, Math.min(320, Math.floor(Number(cfg.bitrate ?? 192))));

  let totalIn = 0;
  const listLines: string[] = [];
  for (const ref of ctx.fileRefs) {
    const path = join(ctx.scratchDir, ref.ref);
    totalIn += sizeOrFallback(path, ref.bytes);
    listLines.push(`file '${path.replace(/'/g, "'\\''")}'`);
  }
  const listPath = join(ctx.scratchDir, "_concat-list.txt");
  await writeFile(listPath, listLines.join("\n"), "utf8");

  const outRef = "merged.mp3";
  const outPath = join(ctx.scratchDir, outRef);

  try {
    await execFileAsync("ffmpeg", [
      "-y", "-f", "concat", "-safe", "0", "-i", listPath,
      "-codec:a", "libmp3lame", "-b:a", `${bitrate}k`, outPath,
    ]);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return errorResult("driver_missing", "ffmpeg not found on PATH");
    return errorResult("ffmpeg_error", `ffmpeg failed: ${(err as { message: string }).message}`);
  }

  ctx.emitProgress(totalIn);
  const outBytes = sizeOrFallback(outPath, 0);
  return {
    ok: true,
    outputs: { fileCount: ctx.fileRefs.length, bitrate },
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
