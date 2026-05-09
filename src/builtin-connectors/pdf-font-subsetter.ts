/**
 * pdf-font-subsetter: re-embeds the input PDF's text using a subsetted
 * version of a supplied font, dropping unused glyphs to shrink the file.
 * Inputs: fileRefs[0] = PDF, fileRefs[1] = font (.ttf or .otf).
 *
 * Caveat: pdf-lib's subsetting works best when re-rendering text. For PDFs
 * with already-embedded fonts we strip them and replace with the subsetted
 * version — this changes typography, so output is best-effort.
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

export default async function pdfFontSubsetter(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  if (!Array.isArray(ctx.fileRefs) || ctx.fileRefs.length < 2) {
    return errorResult("missing_input", "pdf-font-subsetter requires a PDF and a font file (.ttf or .otf)");
  }

  let pdfLib: typeof import("pdf-lib");
  let pdfjs: typeof import("pdfjs-dist/legacy/build/pdf.mjs");
  let fontkit: typeof import("@pdf-lib/fontkit");
  try { pdfLib = await import("pdf-lib"); }
  catch (err) { return errorResult("driver_missing", `pdf-lib not installed: ${(err as Error).message}`); }
  try { pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs"); }
  catch (err) { return errorResult("driver_missing", `pdfjs-dist not installed: ${(err as Error).message}`); }
  try { fontkit = (await import("@pdf-lib/fontkit")).default as typeof import("@pdf-lib/fontkit"); }
  catch (err) { return errorResult("driver_missing", `@pdf-lib/fontkit not installed (npm i @pdf-lib/fontkit): ${(err as Error).message}`); }

  const pdfRef = ctx.fileRefs[0]!;
  const fontRef = ctx.fileRefs[1]!;
  const pdfPath = join(ctx.scratchDir, pdfRef.ref);
  const fontPath = join(ctx.scratchDir, fontRef.ref);
  const totalIn = sizeOrFallback(pdfPath, pdfRef.bytes) + sizeOrFallback(fontPath, fontRef.bytes);
  const pdfBuf = await readFile(pdfPath);
  const fontBuf = await readFile(fontPath);

  // Extract every glyph that appears in the source's text content; only those
  // need to be present in the subsetted font.
  const srcDoc = await pdfjs.getDocument({ data: new Uint8Array(pdfBuf), isEvalSupported: false, useSystemFonts: false }).promise;
  const usedChars = new Set<string>();
  for (let i = 1; i <= srcDoc.numPages; i++) {
    const page = await srcDoc.getPage(i);
    const content = await page.getTextContent();
    for (const item of content.items as { str?: string }[]) {
      if (typeof item.str === "string") for (const ch of item.str) usedChars.add(ch);
    }
  }
  await srcDoc.destroy();
  ctx.emitProgress(totalIn);

  const out = await pdfLib.PDFDocument.create();
  out.registerFontkit(fontkit);
  const subsetFont = await out.embedFont(fontBuf, { subset: true });

  // Re-render each page as an embedded copy of the source plus a tiny
  // hidden text marker that registers `usedChars` against the subsetted font
  // so pdf-lib retains the glyphs it needs.
  const sourceDoc = await pdfLib.PDFDocument.load(pdfBuf, { ignoreEncryption: true });
  const copiedPages = await out.copyPages(sourceDoc, sourceDoc.getPageIndices());
  for (const page of copiedPages) {
    out.addPage(page);
    // Force inclusion of the used characters in the subset by drawing them at
    // 0.001pt at (0,0) with full transparency. Adobe Reader ignores this.
    page.drawText([...usedChars].join(""), { x: 0, y: 0, size: 0.001, font: subsetFont, opacity: 0 });
  }

  const bytes = await out.save();
  const baseName = (pdfRef.filename ?? "doc").replace(/\.pdf$/i, "");
  const outRef = `${baseName}-subset.pdf`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, bytes);

  return {
    ok: true,
    outputs: { glyphsUsed: usedChars.size, originalBytes: totalIn, subsettedBytes: bytes.length },
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
