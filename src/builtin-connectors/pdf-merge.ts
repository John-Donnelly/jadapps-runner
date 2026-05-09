/**
 * pdf-merge: concatenates the input PDFs in upload order and emits one PDF.
 * Pages are copied with their original sizes; no resizing or transforms.
 */

import { readFile } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
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

export default async function pdfMerge(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  if (!Array.isArray(ctx.fileRefs) || ctx.fileRefs.length < 2) {
    return errorResult("missing_input", "pdf-merge requires at least two PDF inputs");
  }

  let pdfLib: typeof import("pdf-lib");
  try { pdfLib = await import("pdf-lib"); }
  catch (err) { return errorResult("driver_missing", `pdf-lib not installed: ${(err as Error).message}`); }

  const out = await pdfLib.PDFDocument.create();
  let totalIn = 0;
  let mergedPageCount = 0;

  for (const ref of ctx.fileRefs) {
    const inPath = join(ctx.scratchDir, ref.ref);
    const fileBytes = sizeOrFallback(inPath, ref.bytes);
    totalIn += fileBytes;
    const buf = await readFile(inPath);
    const src = await pdfLib.PDFDocument.load(buf, { ignoreEncryption: true });
    const pages = await out.copyPages(src, src.getPageIndices());
    for (const p of pages) out.addPage(p);
    mergedPageCount += pages.length;
    ctx.emitProgress(totalIn);
  }

  const bytes = await out.save();
  const outRef = "merged.pdf";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, bytes);

  return {
    ok: true,
    outputs: { fileCount: ctx.fileRefs.length, mergedPageCount },
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
