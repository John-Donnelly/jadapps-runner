/**
 * pdf-split-range: extracts the configured page ranges into individual PDFs.
 * `ranges` is a string like "1-3, 5, 8-10" (1-indexed, inclusive).
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

export default async function pdfSplitRange(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "pdf-split-range requires one PDF input");

  const cfg = ctx.inputs ?? {};
  const rangesSpec = String(cfg.ranges ?? "").trim();
  if (!rangesSpec) return errorResult("invalid_config", "ranges is required (e.g. \"1-3, 5, 8-10\")");

  let pdfLib: typeof import("pdf-lib");
  try { pdfLib = await import("pdf-lib"); }
  catch (err) { return errorResult("driver_missing", `pdf-lib not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  const src = await pdfLib.PDFDocument.load(buf, { ignoreEncryption: true });
  ctx.emitProgress(totalIn);

  const pageCount = src.getPageCount();
  const ranges = parseRanges(rangesSpec, pageCount);
  if (ranges.length === 0) return errorResult("invalid_config", "no valid ranges parsed");

  const baseName = (ref.filename ?? "doc").replace(/\.pdf$/i, "");
  const fileRefs: FileRef[] = [];

  for (let i = 0; i < ranges.length; i++) {
    const range = ranges[i]!;
    const out = await pdfLib.PDFDocument.create();
    const indices: number[] = [];
    for (let p = range.start - 1; p <= range.end - 1; p++) indices.push(p);
    const pages = await out.copyPages(src, indices);
    for (const p of pages) out.addPage(p);
    const bytes = await out.save();
    const outRef = `${baseName}-range-${range.start}-${range.end}.pdf`;
    const outPath = join(ctx.scratchDir, outRef);
    await writeFile(outPath, bytes);
    fileRefs.push({ ref: outRef, bytes: bytes.length, sha256: "", mime: "application/pdf", filename: outRef });
  }

  return {
    ok: true,
    outputs: { rangeCount: ranges.length, totalSourcePages: pageCount },
    fileRefs,
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function parseRanges(spec: string, total: number): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (const piece of spec.split(",")) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    const dashMatch = /^(\d+)\s*-\s*(\d+)$/.exec(trimmed);
    if (dashMatch) {
      const a = Math.max(1, Math.min(total, Number(dashMatch[1])));
      const b = Math.max(1, Math.min(total, Number(dashMatch[2])));
      if (a <= b) out.push({ start: a, end: b });
      continue;
    }
    const single = Number(trimmed);
    if (Number.isInteger(single) && single >= 1 && single <= total) {
      out.push({ start: single, end: single });
    }
  }
  return out;
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
