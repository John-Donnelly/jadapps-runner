/**
 * image-to-pdf: combines one or more images into a single PDF, one image
 * per page. PNGs and JPGs are embedded directly; pages are sized to the
 * image's pixel dimensions converted at 72 DPI.
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

export default async function imageToPdf(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  if (!Array.isArray(ctx.fileRefs) || ctx.fileRefs.length === 0) {
    return errorResult("missing_input", "image-to-pdf requires at least one image");
  }

  const cfg = ctx.inputs ?? {};
  const dpi = Math.max(36, Math.min(600, Number(cfg.dpi ?? 72)));
  const pageSize = String(cfg.pageSize ?? "fit");

  let pdfLib: typeof import("pdf-lib");
  try { pdfLib = await import("pdf-lib"); }
  catch (err) { return errorResult("driver_missing", `pdf-lib not installed: ${(err as Error).message}`); }

  const doc = await pdfLib.PDFDocument.create();
  let totalIn = 0;
  let embedded = 0;
  for (const ref of ctx.fileRefs) {
    const path = join(ctx.scratchDir, ref.ref);
    totalIn += sizeOrFallback(path, ref.bytes);
    const buf = await readFile(path);
    const isPng = buf[0] === 0x89 && buf[1] === 0x50;
    const isJpg = buf[0] === 0xff && buf[1] === 0xd8;
    if (!isPng && !isJpg) continue;
    const image = isPng ? await doc.embedPng(buf) : await doc.embedJpg(buf);
    const widthPts = (image.width / dpi) * 72;
    const heightPts = (image.height / dpi) * 72;
    let pageW = widthPts;
    let pageH = heightPts;
    if (pageSize === "a4") { pageW = 595.28; pageH = 841.89; }
    else if (pageSize === "letter") { pageW = 612; pageH = 792; }
    const page = doc.addPage([pageW, pageH]);
    if (pageSize === "fit") {
      page.drawImage(image, { x: 0, y: 0, width: widthPts, height: heightPts });
    } else {
      const ratio = Math.min(pageW / widthPts, pageH / heightPts);
      const w = widthPts * ratio;
      const h = heightPts * ratio;
      page.drawImage(image, { x: (pageW - w) / 2, y: (pageH - h) / 2, width: w, height: h });
    }
    embedded += 1;
  }
  ctx.emitProgress(totalIn);

  if (embedded === 0) return errorResult("no_images", "no PNG/JPG images found in inputs");

  const bytes = await doc.save();
  const outRef = "images.pdf";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, bytes);

  return {
    ok: true,
    outputs: { embeddedCount: embedded, totalInputCount: ctx.fileRefs.length, dpi, pageSize },
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
