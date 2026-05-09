/**
 * excel-pivot-generator: builds a flat pivot table from a worksheet. Group
 * by `rows` columns, pivot `columns`, and aggregate `valueColumn` using
 * `aggregator` ∈ sum|count|avg|min|max. Output is a new sheet named "Pivot".
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

type Aggregator = "sum" | "count" | "avg" | "min" | "max";

export default async function excelPivotGenerator(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "excel-pivot-generator requires one .xlsx input");

  const cfg = ctx.inputs ?? {};
  const sheetSel = cfg.sheet ?? 1;
  const rowCols = parseList(cfg.rows);
  const colCols = parseList(cfg.columns);
  const valueColumn = cfg.valueColumn;
  const aggregator: Aggregator = (["sum", "count", "avg", "min", "max"] as Aggregator[]).find((a) => a === cfg.aggregator) ?? "sum";
  if (rowCols.length === 0) return errorResult("invalid_config", "rows is required");
  if (valueColumn == null && aggregator !== "count") return errorResult("invalid_config", "valueColumn is required for non-count aggregators");

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

  const matrix = sheetToMatrix(sheet);
  if (matrix.length === 0) return errorResult("empty_sheet", "input sheet is empty");
  const header = (matrix[0] ?? []).map((v) => String(v ?? ""));
  const rowIdxs = rowCols.map((c) => resolveColumn(header, c)).filter((i) => i >= 0);
  const colIdxs = colCols.map((c) => resolveColumn(header, c)).filter((i) => i >= 0);
  const valueIdx = valueColumn != null ? resolveColumn(header, valueColumn) : -1;

  const buckets = new Map<string, Map<string, number[]>>();
  const colKeysSet = new Set<string>();
  for (let i = 1; i < matrix.length; i++) {
    const row = matrix[i] ?? [];
    const rowKey = rowIdxs.map((j) => String(row[j] ?? "")).join("|");
    const colKey = colIdxs.length === 0 ? "_total" : colIdxs.map((j) => String(row[j] ?? "")).join("|");
    colKeysSet.add(colKey);
    const num = aggregator === "count" ? 1 : Number(row[valueIdx] ?? 0);
    if (!Number.isFinite(num) && aggregator !== "count") continue;
    const bucket = buckets.get(rowKey) ?? new Map();
    const arr = bucket.get(colKey) ?? [];
    arr.push(num);
    bucket.set(colKey, arr);
    buckets.set(rowKey, bucket);
  }

  const colKeys = [...colKeysSet].sort();
  const out = new ExcelJS.Workbook();
  const ws = out.addWorksheet("Pivot");
  ws.addRow([...rowIdxs.map((i) => header[i]), ...colKeys]);
  for (const [rowKey, bucket] of buckets) {
    const rowParts = rowKey.split("|");
    const cells = colKeys.map((colKey) => {
      const arr = bucket.get(colKey) ?? [];
      return aggregate(arr, aggregator);
    });
    ws.addRow([...rowParts, ...cells]);
  }

  const outRef = "pivot.xlsx";
  const outPath = join(ctx.scratchDir, outRef);
  await out.xlsx.writeFile(outPath);
  const outBytes = sizeOrFallback(outPath, 0);

  return {
    ok: true,
    outputs: { rowGroups: buckets.size, columnGroups: colKeys.length, aggregator },
    fileRefs: [{ ref: outRef, bytes: outBytes, sha256: "", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function aggregate(arr: number[], aggregator: Aggregator): number | null {
  if (arr.length === 0) return null;
  switch (aggregator) {
    case "count": return arr.length;
    case "sum": return arr.reduce((a, b) => a + b, 0);
    case "avg": return arr.reduce((a, b) => a + b, 0) / arr.length;
    case "min": return Math.min(...arr);
    case "max": return Math.max(...arr);
  }
}

function sheetToMatrix(sheet: import("exceljs").Worksheet): unknown[][] {
  const matrix: unknown[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => matrix.push(Array.isArray(row.values) ? row.values.slice(1) : []));
  return matrix;
}

function parseList(input: unknown): unknown[] {
  if (input == null) return [];
  if (Array.isArray(input)) return input;
  if (typeof input === "string") return input.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
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
