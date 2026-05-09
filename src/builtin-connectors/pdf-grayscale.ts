/**
 * pdf-grayscale: rasterises each page through pdfjs+canvas, applies a luma
 * grayscale conversion to the pixels, then assembles a fresh PDF where each
 * page is the grayscale raster (PNG-embedded). Output PDF preserves page
 * dimensions but loses vector content (it becomes raster).
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

export default async function pdfGrayscale(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "pdf-grayscale requires one PDF input");

  const cfg = ctx.inputs ?? {};
  const dpi = Math.max(72, Math.min(300, Number(cfg.dpi ?? 150)));

  let pdfjs: typeof import("pdfjs-dist/legacy/build/pdf.mjs");
  let canvasMod: typeof import("@napi-rs/canvas");
  let pdfLib: typeof import("pdf-lib");
  try { pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs"); }
  catch (err) { return errorResult("driver_missing", `pdfjs-dist not installed: ${(err as Error).message}`); }
  try { canvasMod = await import("@napi-rs/canvas"); }
  catch (err) { return errorResult("driver_missing", `@napi-rs/canvas not installed: ${(err as Error).message}`); }
  try { pdfLib = await import("pdf-lib"); }
  catch (err) { return errorResult("driver_missing", `pdf-lib not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  const factory = makeCanvasFactory(canvasMod);
  const srcDoc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, useSystemFonts: false, canvasFactory: factory } as never).promise;
  ctx.emitProgress(totalIn);

  const out = await pdfLib.PDFDocument.create();
  const scale = dpi / 72;
  for (let i = 1; i <= srcDoc.numPages; i++) {
    const page = await srcDoc.getPage(i);
    const viewport = page.getViewport({ scale });
    const canvas = canvasMod.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext("2d");
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport, canvas } as never).promise;

    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    const px = imageData.data;
    for (let p = 0; p < px.length; p += 4) {
      const r = px[p]!, g = px[p + 1]!, b = px[p + 2]!;
      const luma = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      px[p] = luma;
      px[p + 1] = luma;
      px[p + 2] = luma;
    }
    context.putImageData(imageData, 0, 0);

    const png = await canvas.encode("png");
    const embedded = await out.embedPng(png);
    // Page dimensions in points: viewport.width/height are in pixels at scale; / scale gives points.
    const pageW = viewport.width / scale;
    const pageH = viewport.height / scale;
    const outPage = out.addPage([pageW, pageH]);
    outPage.drawImage(embedded, { x: 0, y: 0, width: pageW, height: pageH });
  }
  await srcDoc.destroy();

  const bytes = await out.save();
  const baseName = (ref.filename ?? "doc").replace(/\.pdf$/i, "");
  const outRef = `${baseName}-gray.pdf`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, bytes);

  return {
    ok: true,
    outputs: { pageCount: srcDoc.numPages, dpi },
    fileRefs: [{ ref: outRef, bytes: bytes.length, sha256: "", mime: "application/pdf", filename: outRef }],
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
