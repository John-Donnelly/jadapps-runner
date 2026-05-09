/**
 * pdf-extract-pages: extracts a configured set of pages into a single output
 * PDF (preserving the order specified). `pages` is "1,3,5-7" (1-indexed).
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

export default async function pdfExtractPages(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "pdf-extract-pages requires one PDF input");

  const cfg = ctx.inputs ?? {};
  const pagesSpec = String(cfg.pages ?? "").trim();
  if (!pagesSpec) return errorResult("invalid_config", "pages is required (e.g. \"1,3,5-7\")");

  let pdfLib: typeof import("pdf-lib");
  try { pdfLib = await import("pdf-lib"); }
  catch (err) { return errorResult("driver_missing", `pdf-lib not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  const src = await pdfLib.PDFDocument.load(buf, { ignoreEncryption: true });
  ctx.emitProgress(totalIn);

  const pageCount = src.getPageCount();
  const pageList = parsePageList(pagesSpec, pageCount);
  if (pageList.length === 0) return errorResult("invalid_config", "no valid pages parsed");

  const out = await pdfLib.PDFDocument.create();
  const pages = await out.copyPages(src, pageList.map((p) => p - 1));
  for (const p of pages) out.addPage(p);
  const bytes = await out.save();

  const baseName = (ref.filename ?? "doc").replace(/\.pdf$/i, "");
  const outRef = `${baseName}-extracted.pdf`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, bytes);

  return {
    ok: true,
    outputs: { extractedCount: pageList.length, totalSourcePages: pageCount },
    fileRefs: [{ ref: outRef, bytes: bytes.length, sha256: "", mime: "application/pdf", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function parsePageList(spec: string, total: number): number[] {
  const out: number[] = [];
  for (const piece of spec.split(",")) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    const dashMatch = /^(\d+)\s*-\s*(\d+)$/.exec(trimmed);
    if (dashMatch) {
      const a = Math.max(1, Math.min(total, Number(dashMatch[1])));
      const b = Math.max(1, Math.min(total, Number(dashMatch[2])));
      const lo = Math.min(a, b), hi = Math.max(a, b);
      for (let p = lo; p <= hi; p++) out.push(p);
      continue;
    }
    const single = Number(trimmed);
    if (Number.isInteger(single) && single >= 1 && single <= total) out.push(single);
  }
  return out;
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
