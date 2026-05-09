/**
 * pdf-stamp: places a text "stamp" (e.g. "DRAFT", "CONFIDENTIAL") on every
 * page at a configured corner. Differs from pdf-watermark in that it's
 * fully opaque, smaller, and corner-anchored — for compliance labelling
 * rather than branding.
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

export default async function pdfStamp(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "pdf-stamp requires one PDF input");

  const cfg = ctx.inputs ?? {};
  const text = String(cfg.text ?? "").trim();
  if (!text) return errorResult("invalid_config", "text is required");
  const fontSize = Math.max(8, Math.min(72, Number(cfg.fontSize ?? 18)));
  const position = String(cfg.position ?? "top-right");
  const margin = Math.max(0, Number(cfg.margin ?? 24));
  const colorHex = String(cfg.colorHex ?? "#cc0000");

  let pdfLib: typeof import("pdf-lib");
  try { pdfLib = await import("pdf-lib"); }
  catch (err) { return errorResult("driver_missing", `pdf-lib not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  const doc = await pdfLib.PDFDocument.load(buf, { ignoreEncryption: true });
  ctx.emitProgress(totalIn);

  const font = await doc.embedFont(pdfLib.StandardFonts.HelveticaBold);
  const { r, g, b } = parseHexColor(colorHex);
  const color = pdfLib.rgb(r, g, b);
  const pages = doc.getPages();

  for (const page of pages) {
    const { width, height } = page.getSize();
    const tw = font.widthOfTextAtSize(text, fontSize);
    let x = margin;
    let y = margin;
    if (position.startsWith("top")) y = height - margin - fontSize;
    if (position.endsWith("center")) x = width / 2 - tw / 2;
    if (position.endsWith("right")) x = width - margin - tw;
    page.drawText(text, { x, y, size: fontSize, font, color });
  }

  const bytes = await doc.save();
  const baseName = (ref.filename ?? "doc").replace(/\.pdf$/i, "");
  const outRef = `${baseName}-stamped.pdf`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, bytes);

  return {
    ok: true,
    outputs: { pageCount: pages.length, text, position },
    fileRefs: [{ ref: outRef, bytes: bytes.length, sha256: "", mime: "application/pdf", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function parseHexColor(hex: string): { r: number; g: number; b: number } {
  const cleaned = hex.replace(/^#/, "");
  if (cleaned.length === 6) {
    const r = parseInt(cleaned.slice(0, 2), 16) / 255;
    const g = parseInt(cleaned.slice(2, 4), 16) / 255;
    const b = parseInt(cleaned.slice(4, 6), 16) / 255;
    if ([r, g, b].every((v) => Number.isFinite(v))) return { r, g, b };
  }
  return { r: 0.8, g: 0, b: 0 };
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
