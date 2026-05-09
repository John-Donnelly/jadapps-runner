/**
 * pdf-resize: resizes every page to a target paper size (A4, A3, Letter,
 * Legal) or to explicit width/height in points. Preserves page content via
 * a viewport-style scale-to-fit transform.
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
  a4: [595.28, 841.89],
  a3: [841.89, 1190.55],
  a5: [419.53, 595.28],
  letter: [612, 792],
  legal: [612, 1008],
  tabloid: [792, 1224],
};

export default async function pdfResize(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "pdf-resize requires one PDF input");

  const cfg = ctx.inputs ?? {};
  const target = String(cfg.size ?? "a4").toLowerCase();
  const explicit = cfg.width != null && cfg.height != null
    ? [Number(cfg.width), Number(cfg.height)] as [number, number]
    : SIZES[target];
  if (!explicit) return errorResult("invalid_config", `unknown size: ${target}`);

  let pdfLib: typeof import("pdf-lib");
  try { pdfLib = await import("pdf-lib"); }
  catch (err) { return errorResult("driver_missing", `pdf-lib not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  const src = await pdfLib.PDFDocument.load(buf, { ignoreEncryption: true });
  ctx.emitProgress(totalIn);

  const out = await pdfLib.PDFDocument.create();
  const [targetW, targetH] = explicit;
  const pageCount = src.getPageCount();

  for (let i = 0; i < pageCount; i++) {
    const [embedded] = await out.embedPdf(src, [i]);
    const newPage = out.addPage([targetW, targetH]);
    if (!embedded) continue;
    const ratio = Math.min(targetW / embedded.width, targetH / embedded.height);
    const dx = (targetW - embedded.width * ratio) / 2;
    const dy = (targetH - embedded.height * ratio) / 2;
    newPage.drawPage(embedded, { x: dx, y: dy, xScale: ratio, yScale: ratio });
  }

  const bytes = await out.save();
  const baseName = (ref.filename ?? "doc").replace(/\.pdf$/i, "");
  const outRef = `${baseName}-resized.pdf`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, bytes);

  return {
    ok: true,
    outputs: { pageCount, targetWidth: targetW, targetHeight: targetH },
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
