/**
 * id3-editor: writes ID3v2 metadata tags to an MP3 (or comparable container
 * tags to other formats) via ffmpeg's `-metadata` flags. Tags are passed
 * as a JSON object; standard keys: title, artist, album, year, track,
 * genre, comment.
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

export default async function id3Editor(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "id3-editor requires one audio input");

  const cfg = ctx.inputs ?? {};
  const tags = parseTags(cfg.tags);
  if (tags == null) return errorResult("invalid_config", "tags must be a JSON object");
  if (Object.keys(tags).length === 0) return errorResult("invalid_config", "tags object is empty");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const ext = extname(ref.filename ?? ".mp3") || ".mp3";
  const baseName = (ref.filename ?? "audio").replace(/\.[^.]+$/, "");
  const outRef = `${baseName}-tagged${ext}`;
  const outPath = join(ctx.scratchDir, outRef);

  const args = ["-y", "-i", inPath, "-codec", "copy"];
  for (const [k, v] of Object.entries(tags)) args.push("-metadata", `${k}=${String(v)}`);
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
    outputs: { tagsWritten: Object.keys(tags) },
    fileRefs: [{ ref: outRef, bytes: outBytes, sha256: "", mime: ref.mime || "audio/mpeg", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function parseTags(input: unknown): Record<string, string> | null {
  if (input == null) return null;
  if (typeof input === "object" && !Array.isArray(input)) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) out[k] = String(v ?? "");
    return out;
  }
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed)) out[k] = String(v ?? "");
        return out;
      }
    } catch { return null; }
  }
  return null;
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
