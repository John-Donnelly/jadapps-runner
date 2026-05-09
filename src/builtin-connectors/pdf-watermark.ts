/**
 * pdf-watermark: stamps a diagonal text watermark across every page. Uses
 * Helvetica from the standard set (no font file needed). `opacity` 0..1,
 * `angle` in degrees (default -45 = 45° anti-clockwise).
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

export default async function pdfWatermark(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "pdf-watermark requires one PDF input");

  const cfg = ctx.inputs ?? {};
  const text = String(cfg.text ?? "").trim();
  if (!text) return errorResult("invalid_config", "text is required");
  const fontSize = Math.max(8, Math.min(200, Number(cfg.fontSize ?? 64)));
  const opacity = Math.max(0, Math.min(1, Number(cfg.opacity ?? 0.2)));
  const angle = Number(cfg.angle ?? -45);

  let pdfLib: typeof import("pdf-lib");
  try { pdfLib = await import("pdf-lib"); }
  catch (err) { return errorResult("driver_missing", `pdf-lib not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  const doc = await pdfLib.PDFDocument.load(buf, { ignoreEncryption: true });
  ctx.emitProgress(totalIn);

  const font = await doc.embedFont(pdfLib.StandardFonts.Helvetica);
  const pages = doc.getPages();
  const grey = pdfLib.rgb(0.5, 0.5, 0.5);

  for (const page of pages) {
    const { width, height } = page.getSize();
    const textWidth = font.widthOfTextAtSize(text, fontSize);
    page.drawText(text, {
      x: width / 2 - textWidth / 2,
      y: height / 2,
      size: fontSize,
      font,
      color: grey,
      opacity,
      rotate: pdfLib.degrees(angle),
    });
  }

  const bytes = await doc.save();
  const baseName = (ref.filename ?? "doc").replace(/\.pdf$/i, "");
  const outRef = `${baseName}-watermarked.pdf`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, bytes);

  return {
    ok: true,
    outputs: { pageCount: pages.length, text, fontSize, opacity, angle },
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
