/**
 * markdown-to-pdf: renders Markdown to a clean, GitHub-style PDF using
 * marked + Playwright. Reuses the same template as md-to-github-html with
 * paged-media CSS layered on top.
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

export default async function markdownToPdf(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "markdown-to-pdf requires one Markdown input");

  const cfg = ctx.inputs ?? {};
  const format = String(cfg.format ?? "A4");
  const title = String(cfg.title ?? (ref.filename ?? "Document").replace(/\.md$/i, ""));

  let marked: typeof import("marked");
  let playwright: typeof import("playwright");
  try { marked = await import("marked"); }
  catch (err) { return errorResult("driver_missing", `marked not installed: ${(err as Error).message}`); }
  try { playwright = await import("playwright"); }
  catch (err) { return errorResult("driver_missing", `playwright not installed (run npm i playwright in the runner): ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const text = await readFile(inPath, "utf8");

  marked.marked.setOptions({ gfm: true, breaks: true });
  const body = await marked.marked.parse(text);
  const html = wrapHtml(title, body);

  const browser = await playwright.chromium.launch();
  let pdfBytes: Buffer;
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle" });
    pdfBytes = await page.pdf({ format: format as never, printBackground: true, margin: { top: "0.75in", right: "0.75in", bottom: "0.75in", left: "0.75in" } });
  } finally {
    await browser.close();
  }
  ctx.emitProgress(totalIn);

  const baseName = (ref.filename ?? "doc").replace(/\.md$/i, "");
  const outRef = `${baseName}.pdf`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, pdfBytes);

  return {
    ok: true,
    outputs: { format, pdfBytes: pdfBytes.length },
    fileRefs: [{ ref: outRef, bytes: pdfBytes.length, sha256: "", mime: "application/pdf", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function wrapHtml(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>${escapeHtml(title)}</title>
<style>
@page { size: A4; margin: 1in; }
body { font: 11pt/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; color: #1f2328; max-width: 7.5in; margin: 0 auto; }
h1, h2 { padding-bottom: .3em; border-bottom: 1px solid #d1d9e0; page-break-after: avoid; }
h1 { font-size: 1.8em; } h2 { font-size: 1.4em; } h3, h4, h5, h6 { page-break-after: avoid; }
pre { background: #f6f8fa; border: 1px solid #d1d9e0; border-radius: 6px; padding: 12px; overflow-x: hidden; word-wrap: break-word; page-break-inside: avoid; font-size: 9pt; }
code { background: rgba(175,184,193,.2); padding: .2em .4em; border-radius: 4px; font: 0.9em ui-monospace, Consolas, monospace; }
pre code { background: transparent; padding: 0; }
table { border-collapse: collapse; page-break-inside: avoid; }
th, td { border: 1px solid #d1d9e0; padding: 6px 12px; }
th { background: #f6f8fa; }
blockquote { padding: 0 1em; color: #59636e; border-left: .25em solid #d1d9e0; margin: 0 0 1em; page-break-inside: avoid; }
img { max-width: 100%; }
</style></head><body>${body}</body></html>`;
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
