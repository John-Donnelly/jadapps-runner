/**
 * pdf-to-word: extracts text from a PDF (with heading-band inference) and
 * writes it to a .docx. Combines pdfjs (extraction) and the docx package
 * (output). Layout fidelity is text-only; tables/images are dropped.
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

export default async function pdfToWord(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "pdf-to-word requires one PDF input");

  let pdfjs: typeof import("pdfjs-dist/legacy/build/pdf.mjs");
  let docxLib: typeof import("docx");
  try { pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs"); }
  catch (err) { return errorResult("driver_missing", `pdfjs-dist not installed: ${(err as Error).message}`); }
  try { docxLib = await import("docx"); }
  catch (err) { return errorResult("driver_missing", `docx not installed: ${(err as Error).message}`); }
  const { Document, Paragraph, TextRun, HeadingLevel, Packer } = docxLib;

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, useSystemFonts: false }).promise;
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
  const headingMap = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3];
  const paragraphs: import("docx").Paragraph[] = [];

  for (let i = 0; i < pageItems.length; i++) {
    const lines = groupAndClassify(pageItems[i]!, sizeToLevel);
    for (const line of lines) {
      const headMatch = /^(#{1,3})\s+(.*)$/.exec(line);
      if (headMatch && headMatch[1] && headMatch[2]) {
        const level = headMatch[1].length;
        paragraphs.push(new Paragraph({ heading: headingMap[level - 1] ?? HeadingLevel.HEADING_3, children: [new TextRun(headMatch[2])] }));
      } else {
        paragraphs.push(new Paragraph({ children: [new TextRun(line)] }));
      }
    }
  }

  const document = new Document({ sections: [{ properties: {}, children: paragraphs }] });
  const out = await Packer.toBuffer(document);

  const baseName = (ref.filename ?? "doc").replace(/\.pdf$/i, "");
  const outRef = `${baseName}.docx`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, out);

  return {
    ok: true,
    outputs: { pageCount: pageItems.length, paragraphCount: paragraphs.length },
    fileRefs: [{ ref: outRef, bytes: out.length, sha256: "", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", filename: outRef }],
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
    if (level >= 1 && level <= 3) return `${"#".repeat(level)} ${trimmed}`;
    return trimmed;
  }).filter((s) => s !== "");
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
