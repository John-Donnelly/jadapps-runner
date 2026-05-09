/**
 * pdf-split: emits one PDF per page from the input PDF. Page-i becomes
 * `${baseName}-page-${i}.pdf` (1-indexed).
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

export default async function pdfSplit(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "pdf-split requires one PDF input");

  let pdfLib: typeof import("pdf-lib");
  try { pdfLib = await import("pdf-lib"); }
  catch (err) { return errorResult("driver_missing", `pdf-lib not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  const src = await pdfLib.PDFDocument.load(buf, { ignoreEncryption: true });
  ctx.emitProgress(totalIn);

  const baseName = (ref.filename ?? "doc").replace(/\.pdf$/i, "");
  const fileRefs: FileRef[] = [];
  const pageCount = src.getPageCount();
  for (let i = 0; i < pageCount; i++) {
    const out = await pdfLib.PDFDocument.create();
    const [page] = await out.copyPages(src, [i]);
    out.addPage(page);
    const bytes = await out.save();
    const outRef = `${baseName}-page-${i + 1}.pdf`;
    const outPath = join(ctx.scratchDir, outRef);
    await writeFile(outPath, bytes);
    fileRefs.push({ ref: outRef, bytes: bytes.length, sha256: "", mime: "application/pdf", filename: outRef });
  }

  return {
    ok: true,
    outputs: { pageCount },
    fileRefs,
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
