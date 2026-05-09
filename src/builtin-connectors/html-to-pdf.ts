/**
 * html-to-pdf: renders an HTML file to PDF via Playwright (Chromium). Uses
 * the runner's optional `playwright` peer dependency — returns
 * driver_missing if Playwright isn't installed in the runner's node_modules.
 *
 * Caveats: paged-media CSS (`@page`) and print stylesheets are honoured;
 * fonts must already be available to the system or embedded in the HTML
 * via @font-face.
 */

import { readFile, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { StepResult, FileRef } from "../types.js";

interface ToolContext {
  toolId: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRef[];
  scratchDir: string;
  emitProgress(bytes: number): void;
}

export default async function htmlToPdf(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "html-to-pdf requires one HTML input");

  const cfg = ctx.inputs ?? {};
  const format = String(cfg.format ?? "Letter");
  const printBackground = cfg.printBackground !== false;
  const margin = cfg.margin && typeof cfg.margin === "object" ? cfg.margin as { top?: string; right?: string; bottom?: string; left?: string } : { top: "0.5in", right: "0.5in", bottom: "0.5in", left: "0.5in" };

  let playwright: typeof import("playwright");
  try { playwright = await import("playwright"); }
  catch (err) { return errorResult("driver_missing", `playwright not installed (run npm i playwright in the runner): ${(err as Error).message}`); }

  const inPath = resolve(join(ctx.scratchDir, ref.ref));
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const html = await readFile(inPath, "utf8");

  const browser = await playwright.chromium.launch();
  let pdfBytes: Buffer;
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle" });
    pdfBytes = await page.pdf({ format: format as never, printBackground, margin });
  } finally {
    await browser.close();
  }
  ctx.emitProgress(totalIn);

  const baseName = (ref.filename ?? "doc").replace(/\.html?$/i, "");
  const outRef = `${baseName}.pdf`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, pdfBytes);

  return {
    ok: true,
    outputs: { format, originalBytes: totalIn, pdfBytes: pdfBytes.length },
    fileRefs: [{ ref: outRef, bytes: pdfBytes.length, sha256: "", mime: "application/pdf", filename: outRef }],
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
