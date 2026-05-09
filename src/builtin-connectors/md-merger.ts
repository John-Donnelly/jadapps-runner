/**
 * md-merger: concatenates multiple Markdown files in input order. Optional
 * `separator` (default "\n\n---\n\n") is inserted between files.
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

export default async function mdMerger(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  if (!Array.isArray(ctx.fileRefs) || ctx.fileRefs.length === 0) {
    return errorResult("missing_input", "md-merger requires at least one Markdown input");
  }

  const cfg = ctx.inputs ?? {};
  const separator = String(cfg.separator ?? "\n\n---\n\n");
  const addFilenameHeadings = cfg.addFilenameHeadings === true;

  let totalIn = 0;
  const parts: string[] = [];
  for (const ref of ctx.fileRefs) {
    const inPath = join(ctx.scratchDir, ref.ref);
    totalIn += sizeOrFallback(inPath, ref.bytes);
    let chunk = await readFile(inPath, "utf8");
    if (addFilenameHeadings) {
      const name = (ref.filename ?? ref.ref).replace(/\.md$/i, "");
      chunk = `# ${name}\n\n${chunk}`;
    }
    parts.push(chunk);
  }
  ctx.emitProgress(totalIn);

  const merged = parts.join(separator);
  const outRef = "merged.md";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, merged, "utf8");

  return {
    ok: true,
    outputs: { fileCount: ctx.fileRefs.length },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(merged, "utf8"), sha256: "", mime: "text/markdown", filename: outRef }],
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
