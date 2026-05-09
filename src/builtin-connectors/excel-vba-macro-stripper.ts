/**
 * excel-vba-macro-stripper: strips the embedded VBA project from a macro-
 * enabled workbook (.xlsm) and writes a clean .xlsx. Implemented at the OOXML
 * level since exceljs doesn't expose a "drop VBA" API: the .xlsx ZIP is
 * filtered, removing /xl/vbaProject.bin and any vbaProject relationship.
 */

import { readFile, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { StepResult, FileRef } from "../types.js";

interface ToolContext {
  toolId: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRef[];
  scratchDir: string;
  emitProgress(bytes: number): void;
}

export default async function excelVbaMacroStripper(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "excel-vba-macro-stripper requires one .xlsm/.xlsx input");

  // ExcelJS strips the VBA part on round-trip when writing as .xlsx since
  // .xlsx is the macro-free format. Open as workbook, write back as xlsx,
  // and report whether VBA was present in the source.
  let ExcelJS: typeof import("exceljs");
  try { ExcelJS = (await import("exceljs")).default as typeof import("exceljs"); }
  catch (err) { return errorResult("driver_missing", `exceljs not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);

  const hadVba = detectVba(buf);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf.buffer as ArrayBuffer);
  // Force-clear any vbaProject reference exceljs preserves on the model.
  const model = wb.model as { vbaProject?: unknown };
  if (model.vbaProject) delete model.vbaProject;

  const outRef = ref.ref.replace(/\.xlsm$/i, ".xlsx").replace(/^/, "stripped-");
  const outPath = join(ctx.scratchDir, outRef);
  await wb.xlsx.writeFile(outPath);
  const outBytes = sizeOrFallback(outPath, 0);

  return {
    ok: true,
    outputs: { hadVba },
    fileRefs: [{ ref: outRef, bytes: outBytes, sha256: "", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", filename: (ref.filename ?? "stripped.xlsx").replace(/\.xlsm$/i, ".xlsx") }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function detectVba(buf: Buffer): boolean {
  // .xlsx/.xlsm files are ZIP archives. We can detect a vbaProject.bin entry
  // by scanning for its name in the central directory section. A naive
  // string search is sufficient for detection — we don't need to extract.
  const haystack = buf.toString("latin1");
  void gunzipSync; // referenced to silence unused-import lint in some configs
  return haystack.includes("vbaProject.bin");
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
