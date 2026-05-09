/**
 * pdf-ocr: rasters every page (pdfjs+canvas) and runs Tesseract OCR over
 * each. Returns extracted text per page plus a combined document. The
 * Tesseract worker downloads the requested language model on first use
 * (default eng). For multi-language docs, pass `language: "eng+fra"`.
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

export default async function pdfOcr(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "pdf-ocr requires one PDF input");

  const cfg = ctx.inputs ?? {};
  const language = String(cfg.language ?? "eng");
  const dpi = Math.max(150, Math.min(400, Number(cfg.dpi ?? 200)));

  let pdfjs: typeof import("pdfjs-dist/legacy/build/pdf.mjs");
  let canvasMod: typeof import("@napi-rs/canvas");
  let tesseract: typeof import("tesseract.js");
  try { pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs"); }
  catch (err) { return errorResult("driver_missing", `pdfjs-dist not installed: ${(err as Error).message}`); }
  try { canvasMod = await import("@napi-rs/canvas"); }
  catch (err) { return errorResult("driver_missing", `@napi-rs/canvas not installed: ${(err as Error).message}`); }
  try { tesseract = await import("tesseract.js"); }
  catch (err) { return errorResult("driver_missing", `tesseract.js not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  const factory = makeCanvasFactory(canvasMod);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, useSystemFonts: false, canvasFactory: factory } as never).promise;

  const worker = await tesseract.createWorker(language);
  ctx.emitProgress(totalIn);

  const pages: { page: number; text: string; confidence: number }[] = [];
  const scale = dpi / 72;
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale });
    const canvas = canvasMod.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext("2d");
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport, canvas } as never).promise;
    const png = await canvas.encode("png");
    const result = await worker.recognize(png);
    pages.push({ page: i, text: result.data.text.trim(), confidence: result.data.confidence });
  }
  await worker.terminate();
  await doc.destroy();

  const combined = pages.map((p) => p.text).join("\n\f\n");
  const baseName = (ref.filename ?? "doc").replace(/\.pdf$/i, "");
  const textRef = `${baseName}-ocr.txt`;
  const reportRef = "ocr-report.json";
  await writeFile(join(ctx.scratchDir, textRef), combined, "utf8");
  await writeFile(join(ctx.scratchDir, reportRef), JSON.stringify({ language, dpi, pages }, null, 2), "utf8");

  const avgConfidence = pages.length > 0 ? pages.reduce((s, p) => s + p.confidence, 0) / pages.length : 0;
  return {
    ok: true,
    outputs: { pageCount: pages.length, language, avgConfidence: Math.round(avgConfidence * 10) / 10 },
    fileRefs: [
      { ref: textRef, bytes: Buffer.byteLength(combined, "utf8"), sha256: "", mime: "text/plain", filename: textRef },
      { ref: reportRef, bytes: 0, sha256: "", mime: "application/json", filename: reportRef },
    ],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function makeCanvasFactory(canvasMod: typeof import("@napi-rs/canvas")) {
  return {
    create(width: number, height: number) {
      const canvas = canvasMod.createCanvas(width, height);
      return { canvas, context: canvas.getContext("2d") };
    },
    reset(target: { canvas: import("@napi-rs/canvas").Canvas }, width: number, height: number) {
      target.canvas.width = width;
      target.canvas.height = height;
    },
    destroy(target: { canvas: import("@napi-rs/canvas").Canvas }) {
      target.canvas.width = 0;
      target.canvas.height = 0;
    },
  };
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
