/**
 * md-to-html: converts Markdown to standalone HTML using `marked`. Optional
 * `wrapInDocument` produces a full `<!DOCTYPE html>` page; otherwise emits
 * the body fragment only.
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

export default async function mdToHtml(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "md-to-html requires one Markdown input");

  const cfg = ctx.inputs ?? {};
  const wrapInDocument = cfg.wrapInDocument !== false;
  const title = String(cfg.title ?? (ref.filename ?? "Document").replace(/\.md$/i, ""));

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const text = await readFile(inPath, "utf8");
  ctx.emitProgress(totalIn);

  let marked: typeof import("marked");
  try { marked = await import("marked"); }
  catch (err) {
    return errorResult("driver_missing", `marked not installed: ${(err as Error).message}`);
  }

  marked.marked.setOptions({ gfm: false, breaks: false });
  const body = await marked.marked.parse(text);
  const out = wrapInDocument ? wrapHtml(title, body) : body;

  const outRef = `${title}.html`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, out, "utf8");

  return {
    ok: true,
    outputs: { wrapInDocument },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(out, "utf8"), sha256: "", mime: "text/html", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function wrapHtml(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{max-width:760px;margin:2rem auto;padding:0 1rem;font:16px/1.6 system-ui,-apple-system,sans-serif;color:#222}pre{background:#f5f5f5;padding:1rem;overflow:auto}code{font-family:Consolas,Menlo,monospace}h1,h2,h3{line-height:1.25}</style>
</head>
<body>
${body}
</body>
</html>
`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
