/**
 * pdf-to-html: emits a styled HTML document with one `<section>` per PDF
 * page, paragraphs derived from text positions. Same heading inference as
 * pdf-to-markdown.
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

interface TextItem { str: string; transform?: number[]; height?: number; }

export default async function pdfToHtml(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "pdf-to-html requires one PDF input");

  const cfg = ctx.inputs ?? {};
  const title = String(cfg.title ?? (ref.filename ?? "Document").replace(/\.pdf$/i, ""));

  let pdfjs: typeof import("pdfjs-dist/legacy/build/pdf.mjs");
  try { pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs"); }
  catch (err) { return errorResult("driver_missing", `pdfjs-dist not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  const data = new Uint8Array(buf);
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: false }).promise;
  ctx.emitProgress(totalIn);

  const allSizes: number[] = [];
  const pageItems: TextItem[][] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const items = (content.items as TextItem[]).filter((it) => typeof it.str === "string");
    for (const it of items) if (typeof it.height === "number") allSizes.push(it.height);
    pageItems.push(items);
  }
  await doc.destroy();

  const sizeToLevel = computeHeadingBands(allSizes);
  const sections: string[] = [];
  for (let i = 0; i < pageItems.length; i++) {
    const lines = groupAndClassify(pageItems[i]!, sizeToLevel);
    const body = lines.map((line) => {
      if (line.startsWith("#")) {
        const m = /^(#+)\s+(.*)$/.exec(line);
        if (m) {
          const level = Math.min(6, m[1]!.length);
          return `<h${level}>${escapeHtml(m[2] ?? "")}</h${level}>`;
        }
      }
      return `<p>${escapeHtml(line)}</p>`;
    }).join("\n");
    sections.push(`<section data-page="${i + 1}">\n${body}\n</section>`);
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{max-width:760px;margin:2rem auto;padding:0 1rem;font:16px/1.6 system-ui,-apple-system,sans-serif;color:#222}section{margin-bottom:3rem;padding-bottom:1rem;border-bottom:1px solid #e5e7eb}section:last-child{border-bottom:0}</style>
</head>
<body>
${sections.join("\n")}
</body>
</html>
`;

  const baseName = (ref.filename ?? "doc").replace(/\.pdf$/i, "");
  const outRef = `${baseName}.html`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, html, "utf8");

  return {
    ok: true,
    outputs: { pageCount: pageItems.length },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(html, "utf8"), sha256: "", mime: "text/html", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function computeHeadingBands(sizes: number[]): Map<number, number> {
  const map = new Map<number, number>();
  if (sizes.length === 0) return map;
  const unique = [...new Set(sizes.map((s) => Math.round(s * 10) / 10))].sort((a, b) => b - a);
  const median = unique[Math.floor(unique.length / 2)] ?? 12;
  for (const size of unique) {
    if (size >= median * 1.6) map.set(size, 1);
    else if (size >= median * 1.35) map.set(size, 2);
    else if (size >= median * 1.15) map.set(size, 3);
    else map.set(size, 0);
  }
  return map;
}

function groupAndClassify(items: TextItem[], sizeToLevel: Map<number, number>): string[] {
  const lines: { text: string; size: number }[] = [];
  let currentText = "";
  let currentSize = 0;
  let lastY: number | null = null;
  for (const item of items) {
    const y = item.transform ? item.transform[5] : null;
    const size = Math.round((item.height ?? 12) * 10) / 10;
    if (lastY != null && y != null && Math.abs(y - lastY) > 2) {
      if (currentText) lines.push({ text: currentText, size: currentSize });
      currentText = item.str;
      currentSize = size;
    } else {
      currentText += item.str;
      currentSize = Math.max(currentSize, size);
    }
    if (typeof y === "number") lastY = y;
  }
  if (currentText) lines.push({ text: currentText, size: currentSize });

  return lines.map((line) => {
    const trimmed = line.text.trim();
    if (!trimmed) return "";
    const level = sizeToLevel.get(line.size) ?? 0;
    if (level >= 1 && level <= 6) return `${"#".repeat(level)} ${trimmed}`;
    return trimmed;
  }).filter((s) => s !== "");
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
