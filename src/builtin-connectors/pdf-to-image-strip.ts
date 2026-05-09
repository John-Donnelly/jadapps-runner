/**
 * pdf-to-image-strip: rasterises every page of a PDF and stitches them into
 * a single tall PNG (or JPG via `format: "jpg"`). Useful for building a
 * scrollable thumbnail or for image-based diff tooling.
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

export default async function pdfToImageStrip(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "pdf-to-image-strip requires one PDF input");

  const cfg = ctx.inputs ?? {};
  const dpi = Math.max(36, Math.min(300, Number(cfg.dpi ?? 96)));
  const format = cfg.format === "jpg" ? "jpg" : "png";
  const quality = Math.max(1, Math.min(100, Math.floor(Number(cfg.quality ?? 85))));
  const gap = Math.max(0, Number(cfg.gap ?? 8));

  let pdfjs: typeof import("pdfjs-dist/legacy/build/pdf.mjs");
  let canvasMod: typeof import("@napi-rs/canvas");
  try { pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs"); }
  catch (err) { return errorResult("driver_missing", `pdfjs-dist not installed: ${(err as Error).message}`); }
  try { canvasMod = await import("@napi-rs/canvas"); }
  catch (err) { return errorResult("driver_missing", `@napi-rs/canvas not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  const factory = makeCanvasFactory(canvasMod);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, useSystemFonts: false, canvasFactory: factory } as never).promise;
  ctx.emitProgress(totalIn);

  const scale = dpi / 72;
  const pageCanvases: import("@napi-rs/canvas").Canvas[] = [];
  let totalHeight = 0;
  let maxWidth = 0;
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale });
    const canvas = canvasMod.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext("2d");
    if (format === "jpg") { context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height); }
    await page.render({ canvasContext: context, viewport, canvas } as never).promise;
    pageCanvases.push(canvas);
    totalHeight += canvas.height;
    if (canvas.width > maxWidth) maxWidth = canvas.width;
  }
  await doc.destroy();
  totalHeight += gap * Math.max(0, pageCanvases.length - 1);

  const strip = canvasMod.createCanvas(maxWidth, totalHeight);
  const stripCtx = strip.getContext("2d");
  stripCtx.fillStyle = "white";
  stripCtx.fillRect(0, 0, strip.width, strip.height);
  let y = 0;
  for (const canvas of pageCanvases) {
    stripCtx.drawImage(canvas, 0, y);
    y += canvas.height + gap;
  }

  const out = format === "jpg" ? await strip.encode("jpeg", quality) : await strip.encode("png");
  const baseName = (ref.filename ?? "doc").replace(/\.pdf$/i, "");
  const outRef = `${baseName}-strip.${format}`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, out);

  return {
    ok: true,
    outputs: { pageCount: pageCanvases.length, dpi, format, width: maxWidth, height: totalHeight },
    fileRefs: [{ ref: outRef, bytes: out.length, sha256: "", mime: format === "jpg" ? "image/jpeg" : "image/png", filename: outRef }],
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
