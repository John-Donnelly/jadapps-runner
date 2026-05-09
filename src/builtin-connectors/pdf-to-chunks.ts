/**
 * pdf-to-chunks: extracts PDF text and splits it into ~N-token chunks for
 * use as RAG inputs. Each chunk preserves whole sentences and tracks the
 * page range it came from. Token estimate is whitespace-split count.
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

interface TextItem { str: string; transform?: number[]; }

export default async function pdfToChunks(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "pdf-to-chunks requires one PDF input");

  const cfg = ctx.inputs ?? {};
  const targetTokens = Math.max(50, Math.min(4000, Math.floor(Number(cfg.targetTokens ?? 500))));
  const overlap = Math.max(0, Math.min(targetTokens / 2, Math.floor(Number(cfg.overlap ?? 50))));

  let pdfjs: typeof import("pdfjs-dist/legacy/build/pdf.mjs");
  try { pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs"); }
  catch (err) { return errorResult("driver_missing", `pdfjs-dist not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  const data = new Uint8Array(buf);
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: false }).promise;
  ctx.emitProgress(totalIn);

  const sentences: { text: string; page: number }[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const items = (content.items as TextItem[]).filter((it) => typeof it.str === "string");
    const pageText = items.map((it) => it.str).join(" ").replace(/\s+/g, " ").trim();
    for (const sent of splitSentences(pageText)) sentences.push({ text: sent, page: i });
  }
  await doc.destroy();

  const chunks: { text: string; pageRange: [number, number]; tokens: number }[] = [];
  let buffer: { text: string; page: number }[] = [];
  let tokenCount = 0;
  for (const sent of sentences) {
    const sentTokens = sent.text.split(/\s+/).length;
    if (tokenCount + sentTokens > targetTokens && buffer.length > 0) {
      chunks.push(flushChunk(buffer));
      const overlapBuffer: typeof buffer = [];
      let overlapTokens = 0;
      for (let i = buffer.length - 1; i >= 0 && overlapTokens < overlap; i--) {
        overlapBuffer.unshift(buffer[i]!);
        overlapTokens += buffer[i]!.text.split(/\s+/).length;
      }
      buffer = overlapBuffer;
      tokenCount = overlapTokens;
    }
    buffer.push(sent);
    tokenCount += sentTokens;
  }
  if (buffer.length > 0) chunks.push(flushChunk(buffer));

  const out = JSON.stringify({ chunkCount: chunks.length, targetTokens, overlap, chunks }, null, 2);
  const outRef = "chunks.json";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, out, "utf8");

  return {
    ok: true,
    outputs: { chunkCount: chunks.length, targetTokens, overlap, pageCount: doc.numPages },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(out, "utf8"), sha256: "", mime: "application/json", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function flushChunk(buffer: { text: string; page: number }[]): { text: string; pageRange: [number, number]; tokens: number } {
  const text = buffer.map((s) => s.text).join(" ");
  const pageStart = buffer[0]!.page;
  const pageEnd = buffer[buffer.length - 1]!.page;
  return { text, pageRange: [pageStart, pageEnd], tokens: text.split(/\s+/).length };
}

function splitSentences(text: string): string[] {
  if (!text.trim()) return [];
  const parts: string[] = [];
  let buf = "";
  for (let i = 0; i < text.length; i++) {
    buf += text[i];
    if (/[.!?]/.test(text[i] ?? "") && (text[i + 1] === " " || text[i + 1] === undefined)) {
      const trimmed = buf.trim();
      if (trimmed) parts.push(trimmed);
      buf = "";
    }
  }
  const tail = buf.trim();
  if (tail) parts.push(tail);
  return parts;
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
