/**
 * md-math-normalizer: normalises math delimiters. Converts $...$ to \(...\)
 * (or vice versa) for inline math, and $$...$$ to \[...\] (or back). Useful
 * when porting between MathJax/KaTeX/Pandoc dialects.
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

export default async function mdMathNormalizer(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "md-math-normalizer requires one Markdown input");

  const cfg = ctx.inputs ?? {};
  const target = cfg.target === "tex-brackets" ? "tex-brackets" : "dollar";

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const text = await readFile(inPath, "utf8");
  ctx.emitProgress(totalIn);

  let inline = 0;
  let block = 0;
  let transformed = text;

  if (target === "dollar") {
    transformed = transformed.replace(/\\\[([\s\S]*?)\\\]/g, (_, body) => { block++; return `$$${body}$$`; });
    transformed = transformed.replace(/\\\(([\s\S]*?)\\\)/g, (_, body) => { inline++; return `$${body}$`; });
  } else {
    transformed = transformed.replace(/\$\$([\s\S]+?)\$\$/g, (_, body) => { block++; return `\\[${body}\\]`; });
    transformed = transformed.replace(/(?<!\$)\$([^\$\n]+?)\$(?!\$)/g, (_, body) => { inline++; return `\\(${body}\\)`; });
  }

  const outRef = `math-${ref.ref}`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, transformed, "utf8");

  return {
    ok: true,
    outputs: { inlineConverted: inline, blockConverted: block, target },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(transformed, "utf8"), sha256: "", mime: "text/markdown", filename: ref.filename ?? "math.md" }],
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
