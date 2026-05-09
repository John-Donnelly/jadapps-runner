/**
 * pdf-compose: lays multiple input PDFs out N-up on a single output. Each
 * input page becomes one cell of an `cols × rows` grid on a target page.
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

const SIZES: Record<string, [number, number]> = {
  a4: [595.28, 841.89], a3: [841.89, 1190.55], a5: [419.53, 595.28],
  letter: [612, 792], legal: [612, 1008],
};

export default async function pdfCompose(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  if (!Array.isArray(ctx.fileRefs) || ctx.fileRefs.length === 0) {
    return errorResult("missing_input", "pdf-compose requires at least one PDF input");
  }

  const cfg = ctx.inputs ?? {};
  const cols = Math.max(1, Math.min(6, Math.floor(Number(cfg.cols ?? 2))));
  const rows = Math.max(1, Math.min(6, Math.floor(Number(cfg.rows ?? 2))));
  const sizeKey = String(cfg.pageSize ?? "a4").toLowerCase();
  const size = SIZES[sizeKey] ?? SIZES.a4;
  if (!size) return errorResult("invalid_config", `unknown pageSize: ${sizeKey}`);
  const margin = Math.max(0, Number(cfg.margin ?? 24));
  const gap = Math.max(0, Number(cfg.gap ?? 12));

  let pdfLib: typeof import("pdf-lib");
  try { pdfLib = await import("pdf-lib"); }
  catch (err) { return errorResult("driver_missing", `pdf-lib not installed: ${(err as Error).message}`); }

  const out = await pdfLib.PDFDocument.create();
  let totalIn = 0;
  const cellsPerPage = cols * rows;

  const sourcePages: { doc: import("pdf-lib").PDFDocument; index: number }[] = [];
  for (const ref of ctx.fileRefs) {
    const inPath = join(ctx.scratchDir, ref.ref);
    totalIn += sizeOrFallback(inPath, ref.bytes);
    const buf = await readFile(inPath);
    const src = await pdfLib.PDFDocument.load(buf, { ignoreEncryption: true });
    for (let i = 0; i < src.getPageCount(); i++) sourcePages.push({ doc: src, index: i });
  }
  ctx.emitProgress(totalIn);

  const [W, H] = size;
  const cellW = (W - 2 * margin - (cols - 1) * gap) / cols;
  const cellH = (H - 2 * margin - (rows - 1) * gap) / rows;

  let cellOnPage = 0;
  let target: import("pdf-lib").PDFPage | null = null;
  for (const { doc: srcDoc, index } of sourcePages) {
    if (cellOnPage === 0) target = out.addPage([W, H]);
    if (!target) continue;
    const [embedded] = await out.embedPdf(srcDoc, [index]);
    if (!embedded) continue;
    const col = cellOnPage % cols;
    const row = Math.floor(cellOnPage / cols);
    const cellX = margin + col * (cellW + gap);
    const cellY = H - margin - cellH - row * (cellH + gap);
    const ratio = Math.min(cellW / embedded.width, cellH / embedded.height);
    target.drawPage(embedded, { x: cellX + (cellW - embedded.width * ratio) / 2, y: cellY + (cellH - embedded.height * ratio) / 2, xScale: ratio, yScale: ratio });
    cellOnPage = (cellOnPage + 1) % cellsPerPage;
  }

  const bytes = await out.save();
  const outRef = "composed.pdf";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, bytes);

  return {
    ok: true,
    outputs: { sourcePages: sourcePages.length, cellsPerPage, outputPages: out.getPageCount() },
    fileRefs: [{ ref: outRef, bytes: bytes.length, sha256: "", mime: "application/pdf", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
