/**
 * audio-transcribe: transcribes speech to text using whisper.cpp's CLI
 * binary (`whisper-cli` or `whisper`) on PATH. Accepts model selection
 * via `model` (tiny|base|small|medium|large) — caller is responsible for
 * ensuring the model file exists where whisper expects it.
 */

import { readFile, writeFile } from "node:fs/promises";
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

export default async function audioTranscribe(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "audio-transcribe requires one audio input");
  const cfg = ctx.inputs ?? {};
  const language = String(cfg.language ?? "en");
  const modelPath = cfg.modelPath != null ? String(cfg.modelPath) : null;

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);

  // whisper.cpp prefers 16 kHz mono WAV. Pre-convert via ffmpeg.
  const preppedPath = join(ctx.scratchDir, "_whisper-input.wav");
  try {
    await execFileAsync("ffmpeg", ["-y", "-i", inPath, "-ac", "1", "-ar", "16000", "-f", "wav", preppedPath]);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return errorResult("driver_missing", "ffmpeg not found on PATH");
    return errorResult("ffmpeg_error", `ffmpeg pre-process failed: ${(err as { message: string }).message}`);
  }

  const baseName = (ref.filename ?? "audio").replace(/\.[^.]+$/, "");
  const outBase = join(ctx.scratchDir, `${baseName}-transcript`);
  const args = ["-l", language, "-otxt", "-of", outBase, "-f", preppedPath];
  if (modelPath) args.push("-m", modelPath);

  // Try `whisper-cli` first, then `whisper`.
  let usedBinary = "whisper-cli";
  try {
    await execFileAsync("whisper-cli", args);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") {
      usedBinary = "whisper";
      try {
        await execFileAsync("whisper", args);
      } catch (err2) {
        if ((err2 as { code?: string }).code === "ENOENT") {
          return errorResult("driver_missing", "neither whisper-cli nor whisper found on PATH (install whisper.cpp)");
        }
        return errorResult("whisper_error", `whisper failed: ${(err2 as { message: string }).message}`);
      }
    } else {
      return errorResult("whisper_error", `whisper-cli failed: ${(err as { message: string }).message}`);
    }
  }

  const outRef = `${baseName}-transcript.txt`;
  const outPath = `${outBase}.txt`;
  let transcript = "";
  try {
    transcript = await readFile(outPath, "utf8");
    await writeFile(join(ctx.scratchDir, outRef), transcript, "utf8");
  } catch {
    return errorResult("whisper_error", "whisper produced no output file");
  }

  ctx.emitProgress(totalIn);
  return {
    ok: true,
    outputs: { language, charCount: transcript.length, usedBinary },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(transcript, "utf8"), sha256: "", mime: "text/plain", filename: outRef }],
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
