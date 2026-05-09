/**
 * md-heading-shifter: shifts every `#` heading by N levels. Caps at 6;
 * negative shifts that would dip below H1 are clamped. Code fences
 * preserved.
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

export default async function mdHeadingShifter(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "md-heading-shifter requires one Markdown input");

  const cfg = ctx.inputs ?? {};
  const shift = Math.floor(Number(cfg.shift ?? 1));

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const text = await readFile(inPath, "utf8");
  ctx.emitProgress(totalIn);

  let inFence = false;
  let shifted = 0, clamped = 0;
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (/^```/.test(line.trim())) { inFence = !inFence; out.push(line); continue; }
    if (inFence) { out.push(line); continue; }
    const m = /^(#{1,6})(\s+.*)$/.exec(line);
    if (!m || m[1] === undefined) { out.push(line); continue; }
    const original = m[1].length;
    let next = original + shift;
    if (next < 1) { next = 1; clamped += 1; }
    if (next > 6) { next = 6; clamped += 1; }
    if (next !== original) shifted += 1;
    out.push("#".repeat(next) + m[2]);
  }
  const transformed = out.join("\n");

  const outRef = `shifted-${ref.ref}`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, transformed, "utf8");

  return {
    ok: true,
    outputs: { shift, shiftedCount: shifted, clampedCount: clamped },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(transformed, "utf8"), sha256: "", mime: "text/markdown", filename: ref.filename ?? "shifted.md" }],
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
