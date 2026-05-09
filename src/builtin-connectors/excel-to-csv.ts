/**
 * excel-to-csv: extracts a worksheet from an .xlsx file and writes it as CSV.
 * `sheet` selects by 1-based index or by sheet name; defaults to the first
 * sheet. `delimiter` default ",". Formula cells emit their cached evaluated
 * value when present, otherwise the formula expression.
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

export default async function excelToCsv(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "excel-to-csv requires one .xlsx input");

  const cfg = ctx.inputs ?? {};
  const sheetSel = cfg.sheet ?? 1;
  const delim = (typeof cfg.delimiter === "string" && cfg.delimiter) || ",";

  let ExcelJS: typeof import("exceljs");
  try { ExcelJS = (await import("exceljs")).default as typeof import("exceljs"); }
  catch (err) { return errorResult("driver_missing", `exceljs not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(inPath);
  ctx.emitProgress(totalIn);

  const sheet = resolveSheet(wb, sheetSel);
  if (!sheet) return errorResult("sheet_not_found", `sheet ${JSON.stringify(sheetSel)} not found`);

  const rows: string[] = [];
  let rowCount = 0;
  sheet.eachRow({ includeEmpty: false }, (row) => {
    rowCount++;
    const cells: string[] = [];
    const values = Array.isArray(row.values) ? row.values.slice(1) : [];
    for (const v of values) cells.push(escapeCsvField(formatCellValue(v), delim));
    rows.push(cells.join(delim));
  });

  const out = rows.join("\n") + "\n";
  const outRef = `${(ref.filename ?? "sheet").replace(/\.[^.]+$/, "")}.csv`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, out, "utf8");

  return {
    ok: true,
    outputs: { rowCount, sheetName: sheet.name },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(out, "utf8"), sha256: "", mime: "text/csv", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function resolveSheet(wb: import("exceljs").Workbook, sel: unknown) {
  if (typeof sel === "number" && Number.isInteger(sel) && sel > 0) return wb.worksheets[sel - 1];
  if (typeof sel === "string") return wb.getWorksheet(sel);
  return wb.worksheets[0];
}

function formatCellValue(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    const obj = v as { result?: unknown; formula?: string; richText?: { text: string }[]; text?: string; hyperlink?: string };
    if (obj.result !== undefined) return formatCellValue(obj.result);
    if (obj.formula) return `=${obj.formula}`;
    if (Array.isArray(obj.richText)) return obj.richText.map((r) => r.text).join("");
    if (obj.text) return String(obj.text);
    if (obj.hyperlink) return String(obj.hyperlink);
    return JSON.stringify(v);
  }
  return String(v);
}

function escapeCsvField(s: string, delim: string): string {
  if (s.includes(delim) || s.includes('"') || s.includes("\n")) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
