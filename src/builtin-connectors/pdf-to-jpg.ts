/**
 * pdf-to-jpg: rasterises every page of a PDF to a JPEG. Same approach as
 * pdf-to-png but with configurable JPEG quality (1-100, default 85). White
 * background is filled before the page renders, since JPEG has no alpha.
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

export default async function pdfToJpg(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "pdf-to-jpg requires one PDF input");

  const cfg = ctx.inputs ?? {};
  const dpi = Math.max(36, Math.min(600, Number(cfg.dpi ?? 150)));
  const quality = Math.max(1, Math.min(100, Math.floor(Number(cfg.quality ?? 85))));

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
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport, canvas } as never).promise;
    const jpg = await canvas.encode("jpeg", quality);
    const outRef = `${baseName}-page-${String(i).padStart(4, "0")}.jpg`;
    const outPath = join(ctx.scratchDir, outRef);
    await writeFile(outPath, jpg);
    fileRefs.push({ ref: outRef, bytes: jpg.length, sha256: "", mime: "image/jpeg", filename: outRef });
  }
  await doc.destroy();

  return {
    ok: true,
    outputs: { pageCount: doc.numPages, dpi, quality },
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
