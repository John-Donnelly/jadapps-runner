/**
 * pdf-crop: shrinks each page's CropBox by the configured margins (in
 * points). Unlike pdf-resize, this trims away the visible region without
 * re-rendering content.
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

export default async function pdfCrop(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "pdf-crop requires one PDF input");

  const cfg = ctx.inputs ?? {};
  const top = Math.max(0, Number(cfg.top ?? 0));
  const right = Math.max(0, Number(cfg.right ?? 0));
  const bottom = Math.max(0, Number(cfg.bottom ?? 0));
  const left = Math.max(0, Number(cfg.left ?? 0));

  let pdfLib: typeof import("pdf-lib");
  try { pdfLib = await import("pdf-lib"); }
  catch (err) { return errorResult("driver_missing", `pdf-lib not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  const doc = await pdfLib.PDFDocument.load(buf, { ignoreEncryption: true });
  ctx.emitProgress(totalIn);

  const pages = doc.getPages();
  for (const page of pages) {
    const { width, height } = page.getSize();
    const newWidth = Math.max(1, width - left - right);
    const newHeight = Math.max(1, height - top - bottom);
    page.setCropBox(left, bottom, newWidth, newHeight);
    page.setMediaBox(0, 0, width, height);
  }

  const bytes = await doc.save();
  const baseName = (ref.filename ?? "doc").replace(/\.pdf$/i, "");
  const outRef = `${baseName}-cropped.pdf`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, bytes);

  return {
    ok: true,
    outputs: { pageCount: pages.length, top, right, bottom, left },
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
