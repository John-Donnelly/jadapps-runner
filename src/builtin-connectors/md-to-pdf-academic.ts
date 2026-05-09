/**
 * md-to-pdf-academic: renders Markdown to PDF using a Latin-Modern-style
 * academic template. Differences from markdown-to-pdf: serif body font,
 * justified text, indented paragraphs, smaller margins, page numbers.
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

export default async function mdToPdfAcademic(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "md-to-pdf-academic requires one Markdown input");

  const cfg = ctx.inputs ?? {};
  const title = String(cfg.title ?? (ref.filename ?? "Document").replace(/\.md$/i, ""));
  const author = String(cfg.author ?? "");

  let marked: typeof import("marked");
  let playwright: typeof import("playwright");
  try { marked = await import("marked"); }
  catch (err) { return errorResult("driver_missing", `marked not installed: ${(err as Error).message}`); }
  try { playwright = await import("playwright"); }
  catch (err) { return errorResult("driver_missing", `playwright not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const text = await readFile(inPath, "utf8");

  marked.marked.setOptions({ gfm: true, breaks: false });
  const body = await marked.marked.parse(text);
  const html = wrapHtml(title, author, body);

  const browser = await playwright.chromium.launch();
  let pdfBytes: Buffer;
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle" });
    pdfBytes = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "1in", right: "1in", bottom: "1in", left: "1in" },
      displayHeaderFooter: true,
      headerTemplate: "<div></div>",
      footerTemplate: `<div style="font:10pt 'Times New Roman',serif;width:100%;text-align:center;color:#555"><span class="pageNumber"></span></div>`,
    });
  } finally {
    await browser.close();
  }
  ctx.emitProgress(totalIn);

  const baseName = (ref.filename ?? "doc").replace(/\.md$/i, "");
  const outRef = `${baseName}-academic.pdf`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, pdfBytes);

  return {
    ok: true,
    outputs: { template: "academic", pdfBytes: pdfBytes.length },
    fileRefs: [{ ref: outRef, bytes: pdfBytes.length, sha256: "", mime: "application/pdf", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function wrapHtml(title: string, author: string, body: string): string {
  const titleBlock = `<header style="text-align:center;margin-bottom:2em">
<h1 style="font-size:1.8em;border:none;margin-bottom:0.2em">${escapeHtml(title)}</h1>
${author ? `<p style="font-style:italic;margin:0;color:#444">${escapeHtml(author)}</p>` : ""}
</header>`;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>${escapeHtml(title)}</title>
<style>
@page { size: A4; margin: 1in; }
body { font: 11pt/1.55 "Times New Roman", "Latin Modern Roman", Georgia, serif; color: #111; text-align: justify; hyphens: auto; }
h1, h2, h3, h4, h5, h6 { font-family: "Times New Roman", Georgia, serif; font-weight: bold; page-break-after: avoid; }
h1 { font-size: 1.4em; margin-top: 1.5em; }
h2 { font-size: 1.2em; margin-top: 1.2em; }
h3 { font-size: 1.05em; }
p { text-indent: 1.5em; margin: 0.4em 0; }
p:first-of-type, h1 + p, h2 + p, h3 + p { text-indent: 0; }
pre { background: #f5f5f5; border: 1px solid #ddd; padding: 8px; font: 9pt "Latin Modern Mono", Consolas, monospace; page-break-inside: avoid; text-align: left; }
code { font: 0.9em "Latin Modern Mono", Consolas, monospace; background: #f5f5f5; padding: 1px 3px; }
table { border-collapse: collapse; margin: 1em auto; page-break-inside: avoid; }
th, td { border: 1px solid #999; padding: 4px 8px; text-align: left; }
blockquote { margin: 1em 2em; font-style: italic; border-left: none; padding: 0; }
</style></head><body>${titleBlock}${body}</body></html>`;
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
