/**
 * excel-unpivot: converts a wide table (one row per entity, one column per
 * variable) into a long table (one row per entity-variable pair). The
 * `idColumns` stay as identifiers; every other column becomes a value row.
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

export default async function excelUnpivot(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "excel-unpivot requires one .xlsx input");

  const cfg = ctx.inputs ?? {};
  const sheetSel = cfg.sheet ?? 1;
  const idColumns = parseList(cfg.idColumns);
  const variableLabel = String(cfg.variableLabel ?? "variable");
  const valueLabel = String(cfg.valueLabel ?? "value");

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
  if (matrix.length === 0) return errorResult("empty_sheet", "input sheet is empty");

  const header = (matrix[0] ?? []).map((v) => String(v ?? ""));
  const idIndices = idColumns.map((col) => resolveColumn(header, col)).filter((i) => i >= 0);
  const valueIndices = header.map((_, i) => i).filter((i) => !idIndices.includes(i));

  const out = new ExcelJS.Workbook();
  const ws = out.addWorksheet("Unpivoted");
  const newHeader = [...idIndices.map((i) => header[i]), variableLabel, valueLabel];
  ws.addRow(newHeader);

  let outRows = 0;
  for (let r = 1; r < matrix.length; r++) {
    const row = matrix[r] ?? [];
    const idValues = idIndices.map((i) => row[i] ?? null);
    for (const i of valueIndices) {
      const val = row[i];
      if (val == null || val === "") continue;
      ws.addRow([...idValues, header[i], val]);
      outRows += 1;
    }
  }

  const outRef = "unpivoted.xlsx";
  const outPath = join(ctx.scratchDir, outRef);
  await out.xlsx.writeFile(outPath);
  const outBytes = sizeOrFallback(outPath, 0);

  return {
    ok: true,
    outputs: { sourceRows: matrix.length - 1, outputRows: outRows, idColumns: idIndices.map((i) => header[i]), valueColumns: valueIndices.map((i) => header[i]) },
    fileRefs: [{ ref: outRef, bytes: outBytes, sha256: "", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
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
