/**
 * excel-sheet-joiner: VLOOKUP-style left join across two sheets in the same
 * workbook (or one sheet from each of two .xlsx inputs). Joins on a shared
 * key column; appends every right-side column to the left-side row.
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

export default async function excelSheetJoiner(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  if (!Array.isArray(ctx.fileRefs) || ctx.fileRefs.length === 0) {
    return errorResult("missing_input", "excel-sheet-joiner requires at least one .xlsx input");
  }

  const cfg = ctx.inputs ?? {};
  const leftSheetSel = cfg.leftSheet ?? 1;
  const rightSheetSel = cfg.rightSheet ?? 2;
  const leftKey = cfg.leftKey;
  const rightKey = cfg.rightKey ?? leftKey;
  if (leftKey == null) return errorResult("invalid_config", "leftKey is required");

  let ExcelJS: typeof import("exceljs");
  try { ExcelJS = (await import("exceljs")).default as typeof import("exceljs"); }
  catch (err) { return errorResult("driver_missing", `exceljs not installed: ${(err as Error).message}`); }

  const refLeft = ctx.fileRefs[0]!;
  const refRight = ctx.fileRefs[1] ?? refLeft;
  const leftPath = join(ctx.scratchDir, refLeft.ref);
  const rightPath = join(ctx.scratchDir, refRight.ref);
  const totalIn = sizeOrFallback(leftPath, refLeft.bytes) + (refRight === refLeft ? 0 : sizeOrFallback(rightPath, refRight.bytes));

  const leftWb = new ExcelJS.Workbook();
  await leftWb.xlsx.readFile(leftPath);
  const rightWb = refRight === refLeft ? leftWb : new ExcelJS.Workbook();
  if (rightWb !== leftWb) await rightWb.xlsx.readFile(rightPath);
  ctx.emitProgress(totalIn);

  const left = typeof leftSheetSel === "number" ? leftWb.worksheets[leftSheetSel - 1] : leftWb.getWorksheet(String(leftSheetSel));
  const right = typeof rightSheetSel === "number" ? rightWb.worksheets[rightSheetSel - 1] : rightWb.getWorksheet(String(rightSheetSel));
  if (!left || !right) return errorResult("sheet_not_found", "leftSheet or rightSheet not found");

  const leftMatrix = sheetToMatrix(left);
  const rightMatrix = sheetToMatrix(right);
  if (leftMatrix.length === 0 || rightMatrix.length === 0) return errorResult("empty_sheet", "one of the input sheets is empty");

  const leftHeader = (leftMatrix[0] ?? []).map((v) => String(v ?? ""));
  const rightHeader = (rightMatrix[0] ?? []).map((v) => String(v ?? ""));
  const leftKeyIdx = resolveColumn(leftHeader, leftKey);
  const rightKeyIdx = resolveColumn(rightHeader, rightKey);
  if (leftKeyIdx < 0 || rightKeyIdx < 0) return errorResult("invalid_config", "key column not found in one of the sheets");

  const rightLookup = new Map<string, unknown[]>();
  for (let i = 1; i < rightMatrix.length; i++) {
    const row = rightMatrix[i] ?? [];
    const key = String(row[rightKeyIdx] ?? "");
    if (!rightLookup.has(key)) rightLookup.set(key, row);
  }

  const out = new ExcelJS.Workbook();
  const ws = out.addWorksheet("Joined");
  const rightSuffix = rightHeader.map((h, i) => i === rightKeyIdx ? null : `${h}_right`).filter((x): x is string => x != null);
  ws.addRow([...leftHeader, ...rightSuffix]);

  let matched = 0, unmatched = 0;
  for (let i = 1; i < leftMatrix.length; i++) {
    const row = leftMatrix[i] ?? [];
    const key = String(row[leftKeyIdx] ?? "");
    const match = rightLookup.get(key);
    if (match) {
      matched += 1;
      const rightTail = match.filter((_, j) => j !== rightKeyIdx);
      ws.addRow([...row, ...rightTail]);
    } else {
      unmatched += 1;
      ws.addRow([...row, ...rightHeader.filter((_, j) => j !== rightKeyIdx).map(() => null)]);
    }
  }

  const outRef = "joined.xlsx";
  const outPath = join(ctx.scratchDir, outRef);
  await out.xlsx.writeFile(outPath);
  const outBytes = sizeOrFallback(outPath, 0);

  return {
    ok: true,
    outputs: { matched, unmatched, leftRows: leftMatrix.length - 1, rightRows: rightMatrix.length - 1 },
    fileRefs: [{ ref: outRef, bytes: outBytes, sha256: "", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function sheetToMatrix(sheet: import("exceljs").Worksheet): unknown[][] {
  const matrix: unknown[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    matrix.push(Array.isArray(row.values) ? row.values.slice(1) : []);
  });
  return matrix;
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
