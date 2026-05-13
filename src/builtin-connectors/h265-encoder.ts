/**
 * h265-encoder: re-encodes a video using libx265 (HEVC) via ffmpeg. Better
 * compression than H.264 at the same quality but slower to encode and not
 * universally supported in older browsers (use H.264 fallback for web).
 * Configure quality via `crf` (lower = higher quality, default 28) or set
 * `bitrate` (kbps) for constant-bitrate encoding.
 */

import { statSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { StepResult, FileRef } from "../types.js";
import { probeHardware } from "../runtime/hardware.js";
import { selectVideoEncoder } from "../runtime/ffmpeg-encoder.js";

const execFileAsync = promisify(execFile);

interface ToolContext {
  toolId: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRef[];
  scratchDir: string;
  emitProgress(bytes: number): void;
}

export default async function h265Encoder(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "h265-encoder requires one video input");
  const cfg = ctx.inputs ?? {};
  const crf = Math.max(0, Math.min(51, Math.floor(Number(cfg.crf ?? 28))));
  const preset = ["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"].includes(cfg.preset as string) ? cfg.preset as string : "medium";
  const bitrate = cfg.bitrate != null ? Math.max(100, Math.min(50000, Math.floor(Number(cfg.bitrate)))) : null;

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const baseName = (ref.filename ?? "video").replace(/\.[^.]+$/, "");
  const outRef = `${baseName}-h265.mp4`;
  const outPath = join(ctx.scratchDir, outRef);

  // Consult the host probe; pick hevc_nvenc / hevc_qsv / hevc_videotoolbox /
  // hevc_amf / hevc_vaapi when available, otherwise fall back to libx265.
  // preferSoftware lets the caller force libx265 — sometimes the slower
  // software path produces noticeably better output for quality-critical work.
  const preferSoftware = cfg.preferSoftware === true;
  const choice = selectVideoEncoder(await probeHardware(), "hevc", { preferSoftware });

  const args = ["-y", "-i", inPath, "-c:v", choice.encoder];
  if (choice.hardware) {
    // Hardware encoders use family-specific rate-control args; user's
    // libx265 preset/crf knobs don't translate cleanly so we ignore them
    // unless they pass an explicit bitrate (which works on every encoder).
    args.push(...choice.extraArgs);
    if (bitrate != null) args.push("-b:v", `${bitrate}k`);
  } else {
    args.push("-preset", preset);
    if (bitrate != null) args.push("-b:v", `${bitrate}k`);
    else args.push("-crf", String(crf));
  }
  args.push("-c:a", "aac", "-b:a", "192k", "-tag:v", "hvc1", outPath);

  try {
    await execFileAsync("ffmpeg", args, { maxBuffer: 50 * 1024 * 1024 });
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return errorResult("driver_missing", "ffmpeg not found on PATH");
    return errorResult("ffmpeg_error", `ffmpeg failed: ${(err as { message: string }).message}`);
  }

  ctx.emitProgress(totalIn);
  const outBytes = sizeOrFallback(outPath, 0);
  return {
    ok: true,
    outputs: {
      codec: choice.encoder,
      encoderFamily: choice.family,
      hardware: choice.hardware,
      crf: choice.hardware || bitrate != null ? null : crf,
      bitrate,
      preset: choice.hardware ? null : preset,
      originalBytes: totalIn,
      encodedBytes: outBytes,
    },
    fileRefs: [{ ref: outRef, bytes: outBytes, sha256: "", mime: "video/mp4", filename: outRef }],
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
