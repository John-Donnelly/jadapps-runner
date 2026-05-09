/**
 * excel-range-diff: cell-by-cell diff between two sheets at a configured
 * range. Reports added rows, removed rows, and per-cell value changes.
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

interface CellChange { row: number; col: number; address: string; before: unknown; after: unknown; }

export default async function excelRangeDiff(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  if (!Array.isArray(ctx.fileRefs) || ctx.fileRefs.length < 2) {
    return errorResult("missing_input", "excel-range-diff requires two .xlsx inputs");
  }

  const cfg = ctx.inputs ?? {};
  const leftSheetSel = cfg.leftSheet ?? 1;
  const rightSheetSel = cfg.rightSheet ?? 1;

  let ExcelJS: typeof import("exceljs");
  try { ExcelJS = (await import("exceljs")).default as typeof import("exceljs"); }
  catch (err) { return errorResult("driver_missing", `exceljs not installed: ${(err as Error).message}`); }

  const refA = ctx.fileRefs[0]!, refB = ctx.fileRefs[1]!;
  const aPath = join(ctx.scratchDir, refA.ref), bPath = join(ctx.scratchDir, refB.ref);
  const totalIn = sizeOrFallback(aPath, refA.bytes) + sizeOrFallback(bPath, refB.bytes);
  const wbA = new ExcelJS.Workbook(), wbB = new ExcelJS.Workbook();
  await wbA.xlsx.readFile(aPath);
  await wbB.xlsx.readFile(bPath);
  ctx.emitProgress(totalIn);

  const sheetA = typeof leftSheetSel === "number" ? wbA.worksheets[leftSheetSel - 1] : wbA.getWorksheet(String(leftSheetSel));
  const sheetB = typeof rightSheetSel === "number" ? wbB.worksheets[rightSheetSel - 1] : wbB.getWorksheet(String(rightSheetSel));
  if (!sheetA || !sheetB) return errorResult("sheet_not_found", "leftSheet or rightSheet not found");

  const a = sheetToMatrix(sheetA);
  const b = sheetToMatrix(sheetB);
  const maxRows = Math.max(a.length, b.length);
  const maxCols = Math.max(...a.map((r) => r.length), ...b.map((r) => r.length), 0);

  const changes: CellChange[] = [];
  let addedRows = 0, removedRows = 0;
  for (let r = 0; r < maxRows; r++) {
    const aRow = a[r];
    const bRow = b[r];
    if (aRow == null) { addedRows += 1; continue; }
    if (bRow == null) { removedRows += 1; continue; }
    for (let c = 0; c < maxCols; c++) {
      const av = aRow[c] ?? null;
      const bv = bRow[c] ?? null;
      if (!cellEqual(av, bv)) {
        changes.push({ row: r + 1, col: c + 1, address: cellAddress(r + 1, c + 1), before: av, after: bv });
      }
    }
  }

  const out = JSON.stringify({ changeCount: changes.length, addedRows, removedRows, changes }, null, 2);
  const outRef = "range-diff.json";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, out, "utf8");

  return {
    ok: true,
    outputs: { changeCount: changes.length, addedRows, removedRows },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(out, "utf8"), sha256: "", mime: "application/json", filename: outRef }],
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

function cellEqual(a: unknown, b: unknown): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

function cellAddress(row: number, col: number): string {
  let s = "";
  let n = col;
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return `${s}${row}`;
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
