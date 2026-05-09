/**
 * album-art-extractor: pulls the embedded cover image from an audio file
 * (ID3 APIC frame for MP3, MP4 covr atom for M4A/AAC, FLAC PICTURE block).
 * Uses ffmpeg's `-map 0:v` with `-c copy`.
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

export default async function albumArtExtractor(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "album-art-extractor requires one audio input");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const baseName = (ref.filename ?? "audio").replace(/\.[^.]+$/, "");
  const outRef = `${baseName}-cover.jpg`;
  const outPath = join(ctx.scratchDir, outRef);

  try {
    await execFileAsync("ffmpeg", ["-y", "-i", inPath, "-an", "-c:v", "copy", "-map", "0:v?", outPath]);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return errorResult("driver_missing", "ffmpeg not found on PATH");
    return errorResult("no_cover", "no embedded cover art found");
  }

  ctx.emitProgress(totalIn);
  const outBytes = sizeOrFallback(outPath, 0);
  if (outBytes === 0) return errorResult("no_cover", "no embedded cover art found");
  return {
    ok: true,
    outputs: { coverBytes: outBytes },
    fileRefs: [{ ref: outRef, bytes: outBytes, sha256: "", mime: "image/jpeg", filename: outRef }],
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
