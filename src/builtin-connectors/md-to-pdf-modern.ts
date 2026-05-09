/**
 * md-to-pdf-modern: renders Markdown to PDF using a clean modern template.
 * Sans-serif body, generous line-height, accent-coloured headings, code
 * blocks with subtle background and rounded corners.
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

export default async function mdToPdfModern(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "md-to-pdf-modern requires one Markdown input");

  const cfg = ctx.inputs ?? {};
  const title = String(cfg.title ?? (ref.filename ?? "Document").replace(/\.md$/i, ""));
  const accent = String(cfg.accentColor ?? "#4f46e5");

  let marked: typeof import("marked");
  let playwright: typeof import("playwright");
  try { marked = await import("marked"); }
  catch (err) { return errorResult("driver_missing", `marked not installed: ${(err as Error).message}`); }
  try { playwright = await import("playwright"); }
  catch (err) { return errorResult("driver_missing", `playwright not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const text = await readFile(inPath, "utf8");

  marked.marked.setOptions({ gfm: true, breaks: true });
  const body = await marked.marked.parse(text);
  const html = wrapHtml(title, accent, body);

  const browser = await playwright.chromium.launch();
  let pdfBytes: Buffer;
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle" });
    pdfBytes = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "0.6in", right: "0.6in", bottom: "0.6in", left: "0.6in" },
    });
  } finally {
    await browser.close();
  }
  ctx.emitProgress(totalIn);

  const baseName = (ref.filename ?? "doc").replace(/\.md$/i, "");
  const outRef = `${baseName}-modern.pdf`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, pdfBytes);

  return {
    ok: true,
    outputs: { template: "modern", accent, pdfBytes: pdfBytes.length },
    fileRefs: [{ ref: outRef, bytes: pdfBytes.length, sha256: "", mime: "application/pdf", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function wrapHtml(title: string, accent: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>${escapeHtml(title)}</title>
<style>
@page { size: A4; margin: 0.6in; }
body { font: 11pt/1.7 "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #1f2328; }
h1, h2, h3, h4, h5, h6 { color: ${escapeHtml(accent)}; font-weight: 600; page-break-after: avoid; letter-spacing: -0.01em; }
h1 { font-size: 2em; margin-top: 0; padding-bottom: .3em; border-bottom: 3px solid ${escapeHtml(accent)}; }
h2 { font-size: 1.5em; margin-top: 1.6em; }
h3 { font-size: 1.2em; }
p { margin: 0.6em 0; }
pre { background: #f8fafc; border-radius: 8px; padding: 16px; font: 9.5pt ui-monospace, "SF Mono", Consolas, monospace; line-height: 1.5; page-break-inside: avoid; overflow: hidden; word-wrap: break-word; }
code { background: #f1f5f9; padding: 2px 6px; border-radius: 4px; font: 0.9em ui-monospace, "SF Mono", Consolas, monospace; color: #0f172a; }
pre code { background: transparent; padding: 0; }
a { color: ${escapeHtml(accent)}; text-decoration: none; border-bottom: 1px dotted ${escapeHtml(accent)}; }
table { border-collapse: collapse; margin: 1em 0; width: 100%; page-break-inside: avoid; }
th, td { border-bottom: 1px solid #e2e8f0; padding: 8px 12px; text-align: left; }
th { background: #f8fafc; font-weight: 600; color: ${escapeHtml(accent)}; }
blockquote { margin: 1.2em 0; padding: 0.4em 1em; border-left: 4px solid ${escapeHtml(accent)}; background: #f8fafc; border-radius: 0 6px 6px 0; }
ul, ol { padding-left: 1.4em; }
li { margin: 0.2em 0; }
img { max-width: 100%; border-radius: 6px; }
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
