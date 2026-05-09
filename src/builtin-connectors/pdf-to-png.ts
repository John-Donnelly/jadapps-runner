/**
 * pdf-to-png: rasterises every page of a PDF to a PNG file using pdfjs-dist
 * + @napi-rs/canvas. Returns one PNG per page; resolution controlled via
 * `dpi` (default 150).
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

export default async function pdfToPng(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "pdf-to-png requires one PDF input");

  const cfg = ctx.inputs ?? {};
  const dpi = Math.max(36, Math.min(600, Number(cfg.dpi ?? 150)));

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

  const baseName = (ref.filename ?? "doc").replace(/\.pdf$/i, "");
  const fileRefs: FileRef[] = [];
  const scale = dpi / 72;
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale });
    const canvas = canvasMod.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext("2d");
    await page.render({ canvasContext: context, viewport, canvas } as never).promise;
    const png = await canvas.encode("png");
    const outRef = `${baseName}-page-${String(i).padStart(4, "0")}.png`;
    const outPath = join(ctx.scratchDir, outRef);
    await writeFile(outPath, png);
    fileRefs.push({ ref: outRef, bytes: png.length, sha256: "", mime: "image/png", filename: outRef });
  }
  await doc.destroy();

  return {
    ok: true,
    outputs: { pageCount: doc.numPages, dpi },
    fileRefs,
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
