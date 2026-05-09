/**
 * pdf-redact: paints solid black rectangles over the configured page
 * regions. Inputs: { regions: [{page, x, y, width, height}, ...] } in PDF
 * points (origin bottom-left). Produces a fresh PDF with content still
 * present but covered — for true redaction also strip text via
 * pdf-pii-redactor.
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

interface Region { page: number; x: number; y: number; width: number; height: number; }

export default async function pdfRedact(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "pdf-redact requires one PDF input");

  const cfg = ctx.inputs ?? {};
  const regions = parseRegions(cfg.regions);
  if (regions == null) return errorResult("invalid_config", "regions must be an array of {page, x, y, width, height}");
  if (regions.length === 0) return errorResult("invalid_config", "regions list is empty");

  let pdfLib: typeof import("pdf-lib");
  try { pdfLib = await import("pdf-lib"); }
  catch (err) { return errorResult("driver_missing", `pdf-lib not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  const doc = await pdfLib.PDFDocument.load(buf, { ignoreEncryption: true });
  ctx.emitProgress(totalIn);

  const pageCount = doc.getPageCount();
  const black = pdfLib.rgb(0, 0, 0);
  let drawn = 0;
  for (const region of regions) {
    if (region.page < 1 || region.page > pageCount) continue;
    const page = doc.getPage(region.page - 1);
    page.drawRectangle({ x: region.x, y: region.y, width: region.width, height: region.height, color: black });
    drawn += 1;
  }

  const bytes = await doc.save();
  const baseName = (ref.filename ?? "doc").replace(/\.pdf$/i, "");
  const outRef = `${baseName}-redacted.pdf`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, bytes);

  return {
    ok: true,
    outputs: { regionCount: regions.length, drawnCount: drawn, pageCount },
    fileRefs: [{ ref: outRef, bytes: bytes.length, sha256: "", mime: "application/pdf", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function parseRegions(input: unknown): Region[] | null {
  let arr: unknown;
  if (Array.isArray(input)) arr = input;
  else if (typeof input === "string") {
    try { arr = JSON.parse(input); }
    catch { return null; }
  } else return null;
  if (!Array.isArray(arr)) return null;
  const out: Region[] = [];
  for (const r of arr) {
    if (typeof r !== "object" || r == null) continue;
    const region = r as Partial<Region>;
    if (typeof region.page !== "number" || typeof region.x !== "number" || typeof region.y !== "number" || typeof region.width !== "number" || typeof region.height !== "number") continue;
    out.push({ page: region.page, x: region.x, y: region.y, width: region.width, height: region.height });
  }
  return out;
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
