/**
 * face-pixelate: same region-based redaction as face-blur but using a
 * pixelate effect (downscale-then-upscale) for a more "digitally censored"
 * look. Block size controls how chunky the pixels are.
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

export default async function facePixelate(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "face-pixelate requires one video input");
  const cfg = ctx.inputs ?? {};
  const blockSize = Math.max(4, Math.min(100, Math.floor(Number(cfg.blockSize ?? 16))));
  const regions = parseRegions(cfg.regions);

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const baseName = (ref.filename ?? "video").replace(/\.[^.]+$/, "");
  const outRef = `${baseName}-face-pixelated.mp4`;
  const outPath = join(ctx.scratchDir, outRef);

  let filter: string;
  if (regions.length === 0) {
    filter = `[0:v]split[base][orig];[orig]crop=iw:ih/3:0:0,scale=iw/${blockSize}:ih/${blockSize}:flags=neighbor,scale=iw*${blockSize}:ih*${blockSize}:flags=neighbor[pixelated];[base][pixelated]overlay=0:0[v]`;
  } else {
    const labels: string[] = [];
    const splits: string[] = [`[0:v]split=${regions.length + 1}[base]` + regions.map((_, i) => `[r${i}]`).join("")];
    let cropChain = "";
    for (let i = 0; i < regions.length; i++) {
      const r = regions[i]!;
      const px = `px${i}`;
      cropChain += `;[r${i}]crop=${r.width}:${r.height}:${r.x}:${r.y},scale=${Math.max(1, Math.floor(r.width / blockSize))}:${Math.max(1, Math.floor(r.height / blockSize))}:flags=neighbor,scale=${r.width}:${r.height}:flags=neighbor[${px}]`;
      labels.push(px);
    }
    let overlayChain = "";
    let lastBase = "base";
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
    outputs: { regionCount: regions.length, blockSize, mode: regions.length === 0 ? "default-top-third" : "explicit-regions" },
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
