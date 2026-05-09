/**
 * md-minifier: collapses runs of blank lines, trims trailing spaces, and
 * normalises CRLF → LF. Code fences preserved verbatim.
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

export default async function mdMinifier(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "md-minifier requires one Markdown input");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const text = await readFile(inPath, "utf8");
  ctx.emitProgress(totalIn);

  const normalized = text.replace(/\r\n/g, "\n");
  const out: string[] = [];
  let inFence = false;
  let blankRun = 0;
  for (const line of normalized.split("\n")) {
    if (/^```/.test(line.trim())) { inFence = !inFence; out.push(line); blankRun = 0; continue; }
    if (inFence) { out.push(line); blankRun = 0; continue; }
    const trimmed = line.replace(/[ \t]+$/g, "");
    if (trimmed.length === 0) {
      blankRun += 1;
      if (blankRun <= 1) out.push("");
      continue;
    }
    blankRun = 0;
    out.push(trimmed);
  }
  const transformed = out.join("\n").replace(/^\n+/, "").replace(/\n+$/, "\n");

  const outRef = `min-${ref.ref}`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, transformed, "utf8");

  const savedBytes = totalIn - Buffer.byteLength(transformed, "utf8");

  return {
    ok: true,
    outputs: { savedBytes },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(transformed, "utf8"), sha256: "", mime: "text/markdown", filename: ref.filename ?? "min.md" }],
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
