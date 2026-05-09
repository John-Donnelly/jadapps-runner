/**
 * excel-to-json: parses a worksheet into JSON. Output shape:
 *   "array"   -> array of row objects keyed by header
 *   "matrix"  -> array of arrays (no header treatment)
 *   "object"  -> map of sheetName -> array of row objects (when allSheets=true)
 */

import { writeFile } from "node:fs/promises";
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

export default async function excelToJson(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "excel-to-json requires one .xlsx input");

  const cfg = ctx.inputs ?? {};
  const shape = ["array", "matrix", "object"].includes(cfg.shape as string) ? cfg.shape as string : "array";
  const sheetSel = cfg.sheet ?? 1;
  const allSheets = cfg.allSheets === true;
  const headerRow = Math.max(1, Math.floor(Number(cfg.headerRow ?? 1)));

  let ExcelJS: typeof import("exceljs");
  try { ExcelJS = (await import("exceljs")).default as typeof import("exceljs"); }
  catch (err) { return errorResult("driver_missing", `exceljs not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(inPath);
  ctx.emitProgress(totalIn);

  let result: unknown;
  if (allSheets) {
    const out: Record<string, unknown> = {};
    for (const sheet of wb.worksheets) {
      out[sheet.name] = extractRows(sheet, shape, headerRow);
    }
    result = out;
  } else {
    const sheet = typeof sheetSel === "number"
      ? wb.worksheets[sheetSel - 1]
      : (typeof sheetSel === "string" ? wb.getWorksheet(sheetSel) : wb.worksheets[0]);
    if (!sheet) return errorResult("sheet_not_found", `sheet ${JSON.stringify(sheetSel)} not found`);
    result = extractRows(sheet, shape, headerRow);
  }

  const out = JSON.stringify(result, null, 2);
  const outRef = `${(ref.filename ?? "sheet").replace(/\.[^.]+$/, "")}.json`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, out, "utf8");

  return {
    ok: true,
    outputs: { shape, allSheets, sheetCount: wb.worksheets.length },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(out, "utf8"), sha256: "", mime: "application/json", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function extractRows(sheet: import("exceljs").Worksheet, shape: string, headerRow: number): unknown {
  const matrix: unknown[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values = Array.isArray(row.values) ? row.values.slice(1) : [];
    matrix.push(values.map(normalizeCellValue));
  });
  if (shape === "matrix") return matrix;
  if (matrix.length === 0) return [];
  const headers = (matrix[headerRow - 1] ?? []).map((h) => String(h ?? ""));
  const objects: Record<string, unknown>[] = [];
  for (let i = headerRow; i < matrix.length; i++) {
    const row = matrix[i] ?? [];
    const obj: Record<string, unknown> = {};
    for (let j = 0; j < headers.length; j++) obj[headers[j]!] = row[j] ?? null;
    objects.push(obj);
  }
  return objects;
}

function normalizeCellValue(v: unknown): unknown {
  if (v == null) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    const obj = v as { result?: unknown; formula?: string; richText?: { text: string }[]; text?: string; hyperlink?: string };
    if (obj.result !== undefined) return normalizeCellValue(obj.result);
    if (Array.isArray(obj.richText)) return obj.richText.map((r) => r.text).join("");
    if (obj.text) return obj.text;
    if (obj.formula) return `=${obj.formula}`;
    if (obj.hyperlink) return obj.hyperlink;
    return v;
  }
  return v;
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
