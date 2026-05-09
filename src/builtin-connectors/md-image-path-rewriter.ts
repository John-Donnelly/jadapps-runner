/**
 * md-image-path-rewriter: rewrites image paths in `![alt](path)` syntax.
 * Modes:
 *   - "prefix"  → prepend a string
 *   - "replace" → string replace match → with
 *   - "absolute" → resolve relative paths against a base URL
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

export default async function mdImagePathRewriter(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "md-image-path-rewriter requires one Markdown input");

  const cfg = ctx.inputs ?? {};
  const mode = String(cfg.mode ?? "prefix");
  const prefix = String(cfg.prefix ?? "");
  const match = String(cfg.match ?? "");
  const replacement = String(cfg.replacement ?? "");
  const baseUrl = String(cfg.baseUrl ?? "");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const text = await readFile(inPath, "utf8");
  ctx.emitProgress(totalIn);

  let count = 0;
  const transformed = text.replace(/!\[([^\]]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g, (_, alt, url, title) => {
    let next = url;
    if (mode === "prefix" && prefix) next = prefix + url;
    else if (mode === "replace" && match) next = url.split(match).join(replacement);
    else if (mode === "absolute" && baseUrl && !/^([a-z]+:|\/\/|#)/i.test(url)) {
      next = baseUrl.replace(/\/$/, "") + "/" + url.replace(/^\//, "");
    }
    if (next !== url) count += 1;
    return `![${alt}](${next}${title ?? ""})`;
  });

  const outRef = `rewritten-${ref.ref}`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, transformed, "utf8");

  return {
    ok: true,
    outputs: { rewrittenCount: count, mode },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(transformed, "utf8"), sha256: "", mime: "text/markdown", filename: ref.filename ?? "rewritten.md" }],
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
