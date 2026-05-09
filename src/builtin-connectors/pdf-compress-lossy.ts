/**
 * pdf-compress-lossy: rasters every page through pdfjs + canvas, JPEG-encodes
 * each at the configured quality via sharp, and assembles a fresh PDF.
 * Trades vector content fidelity for a much smaller file. Use this when the
 * source has lots of high-resolution embedded images and a target file size.
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

export default async function pdfCompressLossy(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "pdf-compress-lossy requires one PDF input");

  const cfg = ctx.inputs ?? {};
  const dpi = Math.max(72, Math.min(200, Number(cfg.dpi ?? 120)));
  const quality = Math.max(20, Math.min(100, Math.floor(Number(cfg.quality ?? 70))));

  let pdfjs: typeof import("pdfjs-dist/legacy/build/pdf.mjs");
  let canvasMod: typeof import("@napi-rs/canvas");
  let pdfLib: typeof import("pdf-lib");
  let sharpMod: typeof import("sharp");
  try { pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs"); }
  catch (err) { return errorResult("driver_missing", `pdfjs-dist not installed: ${(err as Error).message}`); }
  try { canvasMod = await import("@napi-rs/canvas"); }
  catch (err) { return errorResult("driver_missing", `@napi-rs/canvas not installed: ${(err as Error).message}`); }
  try { pdfLib = await import("pdf-lib"); }
  catch (err) { return errorResult("driver_missing", `pdf-lib not installed: ${(err as Error).message}`); }
  try { sharpMod = (await import("sharp")).default as unknown as typeof import("sharp"); }
  catch (err) { return errorResult("driver_missing", `sharp not installed: ${(err as Error).message}`); }
  const sharp = sharpMod as unknown as (input?: Buffer) => import("sharp").Sharp;

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
    const png = await canvas.encode("png");
    const jpg = await sharp(png).jpeg({ quality, mozjpeg: true }).toBuffer();
    const embedded = await out.embedJpg(jpg);
    const pageW = viewport.width / scale;
    const pageH = viewport.height / scale;
    const outPage = out.addPage([pageW, pageH]);
    outPage.drawImage(embedded, { x: 0, y: 0, width: pageW, height: pageH });
  }
  await srcDoc.destroy();

  const bytes = await out.save();
  const baseName = (ref.filename ?? "doc").replace(/\.pdf$/i, "");
  const outRef = `${baseName}-compressed.pdf`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, bytes);

  const savedBytes = totalIn - bytes.length;
  const savedPct = totalIn > 0 ? Math.round((savedBytes / totalIn) * 100) : 0;

  return {
    ok: true,
    outputs: { pageCount: srcDoc.numPages, originalBytes: totalIn, compressedBytes: bytes.length, savedBytes, savedPct, dpi, quality },
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
