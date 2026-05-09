/**
 * signature-burner: places a PNG/JPG signature image onto every page (or a
 * specific page) of a PDF. Inputs: fileRefs[0] = PDF, fileRefs[1] = image.
 * Position via `position` ∈ {top-left, top-right, bottom-left, bottom-right,
 * top-center, bottom-center} or explicit `x`/`y` (PDF points).
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

export default async function signatureBurner(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  if (!Array.isArray(ctx.fileRefs) || ctx.fileRefs.length < 2) {
    return errorResult("missing_input", "signature-burner requires a PDF and an image (PNG or JPG)");
  }

  const pdfRef = ctx.fileRefs[0]!;
  const imgRef = ctx.fileRefs[1]!;
  const cfg = ctx.inputs ?? {};
  const position = String(cfg.position ?? "bottom-right");
  const margin = Math.max(0, Number(cfg.margin ?? 36));
  const width = Math.max(20, Number(cfg.width ?? 120));
  const opacity = Math.max(0, Math.min(1, Number(cfg.opacity ?? 0.9)));
  const onlyPage = cfg.page != null ? Math.max(1, Math.floor(Number(cfg.page))) : 0;

  let pdfLib: typeof import("pdf-lib");
  try { pdfLib = await import("pdf-lib"); }
  catch (err) { return errorResult("driver_missing", `pdf-lib not installed: ${(err as Error).message}`); }

  const pdfPath = join(ctx.scratchDir, pdfRef.ref);
  const imgPath = join(ctx.scratchDir, imgRef.ref);
  const totalIn = sizeOrFallback(pdfPath, pdfRef.bytes) + sizeOrFallback(imgPath, imgRef.bytes);
  const pdfBuf = await readFile(pdfPath);
  const imgBuf = await readFile(imgPath);
  const doc = await pdfLib.PDFDocument.load(pdfBuf, { ignoreEncryption: true });
  const isPng = imgBuf[0] === 0x89 && imgBuf[1] === 0x50;
  const image = isPng ? await doc.embedPng(imgBuf) : await doc.embedJpg(imgBuf);
  ctx.emitProgress(totalIn);

  const aspect = image.width / image.height;
  const drawW = width;
  const drawH = drawW / aspect;
  const pages = doc.getPages();
  let burned = 0;
  for (let i = 0; i < pages.length; i++) {
    if (onlyPage > 0 && i + 1 !== onlyPage) continue;
    const page = pages[i]!;
    const { width: pageW, height: pageH } = page.getSize();
    const explicitX = cfg.x != null ? Number(cfg.x) : null;
    const explicitY = cfg.y != null ? Number(cfg.y) : null;
    let x = explicitX ?? margin;
    let y = explicitY ?? margin;
    if (explicitX == null) {
      if (position.endsWith("right")) x = pageW - margin - drawW;
      else if (position.endsWith("center")) x = pageW / 2 - drawW / 2;
    }
    if (explicitY == null) {
      if (position.startsWith("top")) y = pageH - margin - drawH;
    }
    page.drawImage(image, { x, y, width: drawW, height: drawH, opacity });
    burned += 1;
  }

  const bytes = await doc.save();
  const baseName = (pdfRef.filename ?? "doc").replace(/\.pdf$/i, "");
  const outRef = `${baseName}-signed.pdf`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, bytes);

  return {
    ok: true,
    outputs: { burnedCount: burned, position, opacity },
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
