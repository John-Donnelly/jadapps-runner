/**
 * pdf-reorder: rewrites a PDF with its pages in the configured order.
 * `order` is a comma list of 1-indexed page numbers. Pages omitted from the
 * order are appended at the end (so output never loses pages).
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

export default async function pdfReorder(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "pdf-reorder requires one PDF input");

  const cfg = ctx.inputs ?? {};
  const orderSpec = String(cfg.order ?? "").trim();
  if (!orderSpec) return errorResult("invalid_config", "order is required (e.g. \"3,1,2,4\")");

  let pdfLib: typeof import("pdf-lib");
  try { pdfLib = await import("pdf-lib"); }
  catch (err) { return errorResult("driver_missing", `pdf-lib not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  const src = await pdfLib.PDFDocument.load(buf, { ignoreEncryption: true });
  ctx.emitProgress(totalIn);

  const pageCount = src.getPageCount();
  const userOrder: number[] = [];
  const seen = new Set<number>();
  for (const piece of orderSpec.split(",")) {
    const n = Number(piece.trim());
    if (Number.isInteger(n) && n >= 1 && n <= pageCount && !seen.has(n)) {
      userOrder.push(n);
      seen.add(n);
    }
  }
  for (let i = 1; i <= pageCount; i++) if (!seen.has(i)) userOrder.push(i);

  const out = await pdfLib.PDFDocument.create();
  const pages = await out.copyPages(src, userOrder.map((p) => p - 1));
  for (const p of pages) out.addPage(p);
  const bytes = await out.save();

  const baseName = (ref.filename ?? "doc").replace(/\.pdf$/i, "");
  const outRef = `${baseName}-reordered.pdf`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, bytes);

  return {
    ok: true,
    outputs: { newOrder: userOrder, pageCount },
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
