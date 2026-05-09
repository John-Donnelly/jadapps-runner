/**
 * face-blur: applies a Gaussian blur to a configured region of every frame
 * in a video via ffmpeg's boxblur+geq mask combo. Region defaults to the
 * top-third (typical "head in interview" framing); pass `regions` to
 * specify exact rectangles.
 *
 * v0.1 doesn't ship face detection — supply the regions yourself, or run
 * detection in a separate pass and feed the boxes here. For the
 * automatic-detection version, integrate a face detector (mediapipe, etc.)
 * in a future tool.
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

interface Region { x: number; y: number; width: number; height: number; }

export default async function faceBlur(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "face-blur requires one video input");
  const cfg = ctx.inputs ?? {};
  const blurStrength = Math.max(2, Math.min(40, Math.floor(Number(cfg.blurStrength ?? 20))));
  const regions = parseRegions(cfg.regions);

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const baseName = (ref.filename ?? "video").replace(/\.[^.]+$/, "");
  const outRef = `${baseName}-face-blurred.mp4`;
  const outPath = join(ctx.scratchDir, outRef);

  // Build a filter graph: split the input into N copies (one per region),
  // crop each, blur it, then overlay back at its original position.
  let filter: string;
  if (regions.length === 0) {
    // Default: blur top third of frame.
    filter = `[0:v]split[base][orig];[orig]crop=iw:ih/3:0:0,boxblur=${blurStrength}[blurred];[base][blurred]overlay=0:0[v]`;
  } else {
    const labels: string[] = [];
    const splits: string[] = [];
    let cropChain = "";
    let lastBase = "base";
    splits.push(`[0:v]split=${regions.length + 1}[base]` + regions.map((_, i) => `[r${i}]`).join(""));
    for (let i = 0; i < regions.length; i++) {
      const r = regions[i]!;
      const blurredLabel = `blur${i}`;
      cropChain += `;[r${i}]crop=${r.width}:${r.height}:${r.x}:${r.y},boxblur=${blurStrength}[${blurredLabel}]`;
      labels.push(blurredLabel);
    }
    let overlayChain = "";
    for (let i = 0; i < regions.length; i++) {
      const r = regions[i]!;
      const out = i === regions.length - 1 ? "v" : `o${i}`;
      overlayChain += `;[${lastBase}][${labels[i]}]overlay=${r.x}:${r.y}[${out}]`;
      lastBase = `o${i}`;
    }
    filter = splits.join("") + cropChain + overlayChain;
  }

  try {
    await execFileAsync("ffmpeg", ["-y", "-i", inPath, "-filter_complex", filter, "-map", "[v]", "-map", "0:a?", "-c:a", "copy", outPath], { maxBuffer: 50 * 1024 * 1024 });
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return errorResult("driver_missing", "ffmpeg not found on PATH");
    return errorResult("ffmpeg_error", `ffmpeg failed: ${(err as { message: string }).message}`);
  }

  ctx.emitProgress(totalIn);
  const outBytes = sizeOrFallback(outPath, 0);
  return {
    ok: true,
    outputs: { regionCount: regions.length, blurStrength, mode: regions.length === 0 ? "default-top-third" : "explicit-regions" },
    fileRefs: [{ ref: outRef, bytes: outBytes, sha256: "", mime: "video/mp4", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function parseRegions(input: unknown): Region[] {
  const list = Array.isArray(input) ? input : (typeof input === "string" ? safeJson(input) : []);
  if (!Array.isArray(list)) return [];
  const out: Region[] = [];
  for (const r of list) {
    if (typeof r !== "object" || r == null) continue;
    const region = r as Partial<Region>;
    if (typeof region.x === "number" && typeof region.y === "number" && typeof region.width === "number" && typeof region.height === "number") {
      out.push({ x: Math.floor(region.x), y: Math.floor(region.y), width: Math.floor(region.width), height: Math.floor(region.height) });
    }
  }
  return out;
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return []; }
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
