/**
 * pdf-to-text: extracts plain text from every page of a PDF using pdfjs-dist
 * (legacy build for Node, no worker required). Pages are joined with form
 * feed (\f) so downstream tools can split them back. Output is UTF-8.
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

export default async function pdfToText(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "pdf-to-text requires one PDF input");

  let pdfjs: typeof import("pdfjs-dist/legacy/build/pdf.mjs");
  try { pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs"); }
  catch (err) { return errorResult("driver_missing", `pdfjs-dist not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  const data = new Uint8Array(buf);
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: false }).promise;
  ctx.emitProgress(totalIn);

  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const lines = groupTextItemsIntoLines(content.items as TextItem[]);
    pages.push(lines.join("\n"));
  }
  await doc.destroy();

  const text = pages.join("\n\f\n");
  const baseName = (ref.filename ?? "doc").replace(/\.pdf$/i, "");
  const outRef = `${baseName}.txt`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, text, "utf8");

  return {
    ok: true,
    outputs: { pageCount: doc.numPages, charCount: text.length },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(text, "utf8"), sha256: "", mime: "text/plain", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

interface TextItem { str: string; transform?: number[]; }

export function groupTextItemsIntoLines(items: TextItem[]): string[] {
  // pdfjs returns items in approximate reading order, but a hard-newline isn't
  // explicit — we infer one when the y-position drops between consecutive items.
  const lines: string[] = [];
  let current = "";
  let lastY: number | null = null;
  for (const item of items) {
    if (typeof item.str !== "string") continue;
    const y = item.transform ? item.transform[5] : null;
    if (lastY != null && y != null && Math.abs(y - lastY) > 2) {
      if (current) lines.push(current);
      current = item.str;
    } else {
      current += item.str;
    }
    if (typeof y === "number") lastY = y;
  }
  if (current) lines.push(current);
  return lines;
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
