/**
 * pdf-split-fixed: splits the input PDF into chunks of N pages each. The
 * trailing chunk holds the remainder.
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

export default async function pdfSplitFixed(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "pdf-split-fixed requires one PDF input");

  const cfg = ctx.inputs ?? {};
  const chunkSize = Math.max(1, Math.floor(Number(cfg.chunkSize ?? 10)));

  let pdfLib: typeof import("pdf-lib");
  try { pdfLib = await import("pdf-lib"); }
  catch (err) { return errorResult("driver_missing", `pdf-lib not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  const src = await pdfLib.PDFDocument.load(buf, { ignoreEncryption: true });
  ctx.emitProgress(totalIn);

  const baseName = (ref.filename ?? "doc").replace(/\.pdf$/i, "");
  const pageCount = src.getPageCount();
  const fileRefs: FileRef[] = [];
  let chunkIndex = 0;

  for (let i = 0; i < pageCount; i += chunkSize) {
    const out = await pdfLib.PDFDocument.create();
    const indices: number[] = [];
    for (let j = i; j < Math.min(pageCount, i + chunkSize); j++) indices.push(j);
    const pages = await out.copyPages(src, indices);
    for (const p of pages) out.addPage(p);
    const bytes = await out.save();
    const outRef = `${baseName}-chunk-${String(chunkIndex).padStart(3, "0")}.pdf`;
    const outPath = join(ctx.scratchDir, outRef);
    await writeFile(outPath, bytes);
    fileRefs.push({ ref: outRef, bytes: bytes.length, sha256: "", mime: "application/pdf", filename: outRef });
    chunkIndex += 1;
  }

  return {
    ok: true,
    outputs: { pageCount, chunkCount: chunkIndex, chunkSize },
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
