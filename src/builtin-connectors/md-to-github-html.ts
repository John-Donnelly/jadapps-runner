/**
 * md-to-github-html: GitHub-flavoured Markdown -> HTML using `marked` with
 * GFM enabled. Produces a full HTML document styled to resemble GitHub's
 * rendered Markdown view (system fonts, bordered code blocks, alert blocks).
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

export default async function mdToGithubHtml(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "md-to-github-html requires one Markdown input");

  const cfg = ctx.inputs ?? {};
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

  marked.marked.setOptions({ gfm: true, breaks: true });
  const body = await marked.marked.parse(text);
  const out = wrapHtml(title, body);

  const outRef = `${title}.html`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, out, "utf8");

  return {
    ok: true,
    outputs: {},
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
<style>
:root{color-scheme:light dark}
body{max-width:980px;margin:2rem auto;padding:1rem;font:16px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;color:#1f2328;background:#fff}
@media (prefers-color-scheme:dark){body{color:#e6edf3;background:#0d1117}pre,code{background:#161b22 !important;border-color:#30363d !important}}
h1,h2{padding-bottom:.3em;border-bottom:1px solid #d1d9e0}
h1{font-size:2em}h2{font-size:1.5em}h3{font-size:1.25em}
pre{background:#f6f8fa;border:1px solid #d1d9e0;border-radius:6px;padding:16px;overflow:auto}
code{background:rgba(175,184,193,.2);padding:.2em .4em;border-radius:6px;font:0.85em ui-monospace,Menlo,Consolas,monospace}
pre code{background:transparent;padding:0;border-radius:0}
table{border-collapse:collapse}th,td{border:1px solid #d1d9e0;padding:6px 13px}th{background:#f6f8fa}
blockquote{padding:0 1em;color:#59636e;border-left:.25em solid #d1d9e0;margin:0 0 1em}
img{max-width:100%}
</style>
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
