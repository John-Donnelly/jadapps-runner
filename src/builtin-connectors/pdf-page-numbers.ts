/**
 * pdf-page-numbers: stamps a page number on every page. Position via
 * `position` ∈ {"bottom-center","bottom-right","bottom-left","top-center",
 * "top-right","top-left"}. Format string supports {n} for current and
 * {total} for total page count.
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

export default async function pdfPageNumbers(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "pdf-page-numbers requires one PDF input");

  const cfg = ctx.inputs ?? {};
  const format = String(cfg.format ?? "{n} / {total}");
  const position = String(cfg.position ?? "bottom-center");
  const fontSize = Math.max(6, Math.min(48, Number(cfg.fontSize ?? 10)));
  const margin = Math.max(0, Number(cfg.margin ?? 24));
  const startNumber = Math.max(1, Math.floor(Number(cfg.startNumber ?? 1)));

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
  const black = pdfLib.rgb(0, 0, 0);

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]!;
    const { width, height } = page.getSize();
    const text = format.replace(/\{n\}/g, String(startNumber + i)).replace(/\{total\}/g, String(pages.length));
    const tw = font.widthOfTextAtSize(text, fontSize);
    let x = margin;
    let y = margin;
    if (position.startsWith("top")) y = height - margin - fontSize;
    if (position.endsWith("center")) x = width / 2 - tw / 2;
    if (position.endsWith("right")) x = width - margin - tw;
    page.drawText(text, { x, y, size: fontSize, font, color: black });
  }

  const bytes = await doc.save();
  const baseName = (ref.filename ?? "doc").replace(/\.pdf$/i, "");
  const outRef = `${baseName}-numbered.pdf`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, bytes);

  return {
    ok: true,
    outputs: { pageCount: pages.length, position, format },
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
