/**
 * visible-watermark: composites text or an image watermark onto the
 * input image at a configured corner with adjustable opacity.
 */

import { readFile, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { join } from "node:path";
import type { StepResult, FileRef } from "../types.js";

interface ToolContext {
  toolId: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRef[];
  scratchDir: string;
  emitProgress(bytes: number): void;
}

export default async function visibleWatermark(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "visible-watermark requires one image input");
  let sharp: typeof import("sharp");
  try { sharp = (await import("sharp")).default as unknown as typeof import("sharp"); }
  catch (err) { return errorResult("driver_missing", `sharp not installed: ${(err as Error).message}`); }
  const cfg = ctx.inputs ?? {};
  const text = String(cfg.text ?? "© Watermark");
  const opacity = Math.max(0.05, Math.min(1, Number(cfg.opacity ?? 0.5)));
  const position = ["southeast", "southwest", "northeast", "northwest", "center"].includes(String(cfg.position ?? "southeast")) ? String(cfg.position ?? "southeast") : "southeast";

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);
  const factory = sharp as unknown as (b: Buffer) => {
    metadata(): Promise<{ width?: number; height?: number }>;
    composite(c: { input: Buffer; gravity: string }[]): { toBuffer(): Promise<Buffer> };
  };
  const meta = await factory(buf).metadata();
  const w = meta.width ?? 800;
  const fontSize = Math.max(16, Math.round(w / 25));
  const svg = `<svg width="${w}" height="${fontSize * 2}" xmlns="http://www.w3.org/2000/svg"><text x="100%" y="50%" font-family="sans-serif" font-size="${fontSize}" fill="white" fill-opacity="${opacity}" stroke="black" stroke-opacity="${opacity * 0.5}" stroke-width="1" text-anchor="end" dominant-baseline="central">${escapeXml(text)}</text></svg>`;
  const out = await factory(buf).composite([{ input: Buffer.from(svg), gravity: position }]).toBuffer();
  const outRef = (ref.filename ?? ref.ref).replace(/(\.[^.]+)$/, ".watermarked$1");
  await writeFile(join(ctx.scratchDir, outRef), out);
  return { ok: true, outputs: { text, position, opacity, inputBytes: buf.length, outputBytes: out.length }, fileRefs: [{ ref: outRef, bytes: out.length, sha256: "", mime: ref.mime, filename: outRef }], bytesProcessed: totalIn, durationMs: Date.now() - start };
}

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function sizeOrFallback(path: string, fallback: number): number { try { return statSync(path).size; } catch { return fallback; } }
function errorResult(code: string, message: string): StepResult { return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } }; }
