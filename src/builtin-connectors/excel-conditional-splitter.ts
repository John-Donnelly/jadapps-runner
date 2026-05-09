/**
 * excel-conditional-splitter: splits the rows of a sheet into multiple sheets
 * based on the distinct values of a column. Output workbook contains one
 * sheet per group plus a copy of the original header row.
 */

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

export default async function excelConditionalSplitter(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "excel-conditional-splitter requires one .xlsx input");

  const cfg = ctx.inputs ?? {};
  const sheetSel = cfg.sheet ?? 1;
  const groupBy = cfg.groupBy;
  if (groupBy == null || groupBy === "") return errorResult("invalid_config", "groupBy is required (column name or 1-based index)");
  const headerRow = Math.max(1, Math.floor(Number(cfg.headerRow ?? 1)));

  let ExcelJS: typeof import("exceljs");
  try { ExcelJS = (await import("exceljs")).default as typeof import("exceljs"); }
  catch (err) { return errorResult("driver_missing", `exceljs not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(inPath);
  ctx.emitProgress(totalIn);

  const sheet = typeof sheetSel === "number" ? wb.worksheets[sheetSel - 1] : wb.getWorksheet(String(sheetSel));
  if (!sheet) return errorResult("sheet_not_found", `sheet ${JSON.stringify(sheetSel)} not found`);

  const matrix: unknown[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    matrix.push(Array.isArray(row.values) ? row.values.slice(1) : []);
  });
  const header = (matrix[headerRow - 1] ?? []).map((h) => String(h ?? ""));
  const colIdx = resolveColumn(header, groupBy);
  if (colIdx < 0) return errorResult("invalid_config", `groupBy column not found: ${JSON.stringify(groupBy)}`);

  const groups = new Map<string, unknown[][]>();
  for (let i = headerRow; i < matrix.length; i++) {
    const row = matrix[i] ?? [];
    const key = String(row[colIdx] ?? "(blank)");
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  const out = new ExcelJS.Workbook();
  for (const [name, rows] of groups) {
    const safeName = name.replace(/[\\/?*\[\]:]/g, "_").slice(0, 31) || "(blank)";
    const ws = out.addWorksheet(safeName);
    ws.addRow(header);
    for (const row of rows) ws.addRow(row);
  }
  if (out.worksheets.length === 0) {
    return errorResult("empty_output", "no rows after the header row to split");
  }

  const outRef = `split-${ref.ref}`;
  const outPath = join(ctx.scratchDir, outRef);
  await out.xlsx.writeFile(outPath);
  const outBytes = sizeOrFallback(outPath, 0);

  return {
    ok: true,
    outputs: { groupCount: groups.size, sheetName: sheet.name, groupBy: header[colIdx] },
    fileRefs: [{ ref: outRef, bytes: outBytes, sha256: "", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", filename: ref.filename ?? "split.xlsx" }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function resolveColumn(header: string[], col: unknown): number {
  if (typeof col === "number" && Number.isInteger(col) && col > 0 && col <= header.length) return col - 1;
  return header.indexOf(String(col));
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
