/**
 * pdf-summary-generator: produces an extractive summary by scoring sentences
 * via TF-IDF over the full document and selecting the top-N. No LLM required
 * — for v0.1 this gives a "digest" without external calls. When LLM-quality
 * summaries are needed, pair pdf-to-text with an LLM tool.
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

interface TextItem { str: string; }

const STOP = new Set("the a an and or but for so nor yet of in on at to from with by as is are was were be been being have has had do does did this that these those it its he she they we i you my your our their".split(/\s+/));

export default async function pdfSummaryGenerator(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "pdf-summary-generator requires one PDF input");

  const cfg = ctx.inputs ?? {};
  const sentenceCount = Math.max(1, Math.min(50, Math.floor(Number(cfg.sentenceCount ?? 10))));

  let pdfjs: typeof import("pdfjs-dist/legacy/build/pdf.mjs");
  try { pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs"); }
  catch (err) { return errorResult("driver_missing", `pdfjs-dist not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  const data = new Uint8Array(buf);
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: false }).promise;
  ctx.emitProgress(totalIn);

  const fullText: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const items = (content.items as TextItem[]).filter((it) => typeof it.str === "string");
    fullText.push(items.map((it) => it.str).join(" "));
  }
  await doc.destroy();

  const document = fullText.join(" ").replace(/\s+/g, " ").trim();
  const sentences = splitSentences(document);
  if (sentences.length === 0) {
    return errorResult("empty_text", "no extractable text in PDF (may need OCR)");
  }

  const scored = scoreSentences(sentences);
  const top = [...scored.entries()].sort((a, b) => b[1] - a[1]).slice(0, sentenceCount).map(([idx]) => idx).sort((a, b) => a - b);
  const summary = top.map((i) => sentences[i]).join(" ");

  const out = JSON.stringify({ totalSentences: sentences.length, summarySentences: top.length, summary }, null, 2);
  const outRef = "summary.json";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, out, "utf8");

  return {
    ok: true,
    outputs: { totalSentences: sentences.length, summarySentences: top.length, summary },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(out, "utf8"), sha256: "", mime: "application/json", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function scoreSentences(sentences: string[]): Map<number, number> {
  const tokens = sentences.map((s) => s.toLowerCase().split(/\W+/).filter((t) => t && !STOP.has(t)));
  const docFreq = new Map<string, number>();
  for (const sentenceTokens of tokens) {
    const seen = new Set(sentenceTokens);
    for (const t of seen) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
  }
  const N = sentences.length;
  const scores = new Map<number, number>();
  for (let i = 0; i < tokens.length; i++) {
    const sentenceTokens = tokens[i] ?? [];
    if (sentenceTokens.length === 0) { scores.set(i, 0); continue; }
    let score = 0;
    const tf = new Map<string, number>();
    for (const t of sentenceTokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const [term, count] of tf) {
      const df = docFreq.get(term) ?? 1;
      const idf = Math.log(N / df);
      score += count * idf;
    }
    scores.set(i, score / sentenceTokens.length);
  }
  return scores;
}

function splitSentences(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  let buf = "";
  for (let i = 0; i < text.length; i++) {
    buf += text[i];
    if (/[.!?]/.test(text[i] ?? "") && (text[i + 1] === " " || text[i + 1] === undefined)) {
      const trimmed = buf.trim();
      if (trimmed.length > 5) out.push(trimmed);
      buf = "";
    }
  }
  const tail = buf.trim();
  if (tail.length > 5) out.push(tail);
  return out;
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
