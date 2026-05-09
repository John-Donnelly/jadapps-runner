/**
 * dicom-to-pdf: parses one or more DICOM files (.dcm) via dcmjs, extracts
 * each frame's pixel data, encodes as PNG via sharp, and assembles into a
 * single PDF (one image per page). Includes a header on each page with
 * patient/study metadata.
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

export default async function dicomToPdf(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  if (!Array.isArray(ctx.fileRefs) || ctx.fileRefs.length === 0) {
    return errorResult("missing_input", "dicom-to-pdf requires at least one .dcm input");
  }

  const cfg = ctx.inputs ?? {};
  const includeMetadata = cfg.includeMetadata !== false;

  let dcmjs: typeof import("dcmjs");
  let pdfLib: typeof import("pdf-lib");
  let sharpMod: typeof import("sharp");
  try { dcmjs = await import("dcmjs"); }
  catch (err) { return errorResult("driver_missing", `dcmjs not installed: ${(err as Error).message}`); }
  try { pdfLib = await import("pdf-lib"); }
  catch (err) { return errorResult("driver_missing", `pdf-lib not installed: ${(err as Error).message}`); }
  try { sharpMod = (await import("sharp")).default as unknown as typeof import("sharp"); }
  catch (err) { return errorResult("driver_missing", `sharp not installed: ${(err as Error).message}`); }
  const sharp = sharpMod as unknown as (input?: Buffer | { create: { width: number; height: number; channels: 1 | 2 | 3 | 4; background: string } }) => import("sharp").Sharp;

  const out = await pdfLib.PDFDocument.create();
  const helvetica = await out.embedFont(pdfLib.StandardFonts.Helvetica);
  const helveticaBold = await out.embedFont(pdfLib.StandardFonts.HelveticaBold);
  let totalIn = 0;
  let frameCount = 0;

  for (const ref of ctx.fileRefs) {
    const path = join(ctx.scratchDir, ref.ref);
    totalIn += sizeOrFallback(path, ref.bytes);
    const buf = await readFile(path);
    const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    let dataset: { dict: Record<string, { Value?: unknown[] }> };
    try { dataset = (dcmjs.data.DicomMessage.readFile(arrayBuffer) as unknown as { dict: Record<string, { Value?: unknown[] }> }); }
    catch (err) { return errorResult("parse_error", `${ref.filename}: ${(err as Error).message}`); }
    const meta = (dcmjs.data.DicomMetaDictionary.naturalizeDataset(dataset.dict)) as Record<string, unknown>;
    const rows = Number(meta.Rows ?? 0);
    const cols = Number(meta.Columns ?? 0);
    const pixelData = (meta.PixelData as Uint8Array[] | undefined)?.[0];
    if (rows === 0 || cols === 0 || !pixelData) continue;

    // Convert the raw pixel data to a normalised 8-bit grayscale buffer for sharp.
    const bitsAllocated = Number(meta.BitsAllocated ?? 8);
    const samplesPerPixel = Number(meta.SamplesPerPixel ?? 1);
    const grayscale = normalizePixels(pixelData, rows, cols, bitsAllocated, samplesPerPixel);
    // Build a PNG directly from the raw grayscale buffer.
    const sharpFactory = sharp as unknown as (input: Buffer, opts: { raw: { width: number; height: number; channels: 1 } }) => import("sharp").Sharp;
    const finalPng = await sharpFactory(grayscale, { raw: { width: cols, height: rows, channels: 1 } }).png().toBuffer();
    const embedded = await out.embedPng(finalPng);

    const pageW = Math.max(595, embedded.width);
    const pageH = Math.max(842, embedded.height + (includeMetadata ? 80 : 0));
    const page = out.addPage([pageW, pageH]);
    const imageY = includeMetadata ? pageH - embedded.height - 80 : (pageH - embedded.height) / 2;
    page.drawImage(embedded, { x: (pageW - embedded.width) / 2, y: imageY, width: embedded.width, height: embedded.height });

    if (includeMetadata) {
      const lines = [
        `Patient: ${escapeForPdf(String(meta.PatientName ?? "(anonymous)"))}`,
        `Study: ${escapeForPdf(String(meta.StudyDescription ?? "—"))}    Modality: ${escapeForPdf(String(meta.Modality ?? "—"))}`,
        `Date: ${escapeForPdf(String(meta.StudyDate ?? "—"))}    Resolution: ${cols} × ${rows}`,
      ];
      page.drawText(`DICOM frame ${frameCount + 1}`, { x: 24, y: pageH - 28, size: 12, font: helveticaBold, color: pdfLib.rgb(0, 0, 0) });
      lines.forEach((line, idx) => {
        page.drawText(line, { x: 24, y: pageH - 50 - idx * 16, size: 9, font: helvetica, color: pdfLib.rgb(0.2, 0.2, 0.2) });
      });
    }
    frameCount += 1;
  }
  ctx.emitProgress(totalIn);

  if (frameCount === 0) return errorResult("no_frames", "no parseable image frames in inputs");

  const bytes = await out.save();
  const outRef = "dicom-export.pdf";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, bytes);

  return {
    ok: true,
    outputs: { fileCount: ctx.fileRefs.length, frameCount, includeMetadata },
    fileRefs: [{ ref: outRef, bytes: bytes.length, sha256: "", mime: "application/pdf", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function normalizePixels(raw: Uint8Array, rows: number, cols: number, bitsAllocated: number, samplesPerPixel: number): Buffer {
  const total = rows * cols;
  const out = Buffer.alloc(total);
  if (bitsAllocated === 8) {
    if (samplesPerPixel === 1) {
      for (let i = 0; i < total; i++) out[i] = raw[i] ?? 0;
    } else {
      // average channels
      for (let i = 0; i < total; i++) {
        let sum = 0;
        for (let c = 0; c < samplesPerPixel; c++) sum += raw[i * samplesPerPixel + c] ?? 0;
        out[i] = Math.round(sum / samplesPerPixel);
      }
    }
    return out;
  }
  // 16-bit grayscale (most CT/MR DICOMs) — find min/max for window-level
  // normalisation since we don't know the rescale slope/intercept here.
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < total; i++) {
    const v = view.getUint16(i * 2, true);
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = Math.max(1, max - min);
  for (let i = 0; i < total; i++) {
    const v = view.getUint16(i * 2, true);
    out[i] = Math.round(((v - min) / range) * 255);
  }
  return out;
}

function escapeForPdf(s: string): string {
  return s.replace(/[^\x20-\x7e]/g, "?");
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
