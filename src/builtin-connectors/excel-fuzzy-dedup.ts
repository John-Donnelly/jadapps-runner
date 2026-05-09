/**
 * excel-fuzzy-dedup: drops rows whose `column` value is a fuzzy near-match of
 * an earlier row's value. Distance is normalised Levenshtein; threshold ∈
 * [0, 1] where 0 = exact match, 1 = unrelated. Default threshold 0.15.
 *
 * Memory: O(unique rows), like csv-deduplicator.
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

export default async function excelFuzzyDedup(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "excel-fuzzy-dedup requires one .xlsx input");

  const cfg = ctx.inputs ?? {};
  const sheetSel = cfg.sheet ?? 1;
  const column = cfg.column;
  const threshold = Math.max(0, Math.min(1, Number(cfg.threshold ?? 0.15)));
  const caseSensitive = cfg.caseSensitive === true;
  if (column == null) return errorResult("invalid_config", "column is required");

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
  sheet.eachRow({ includeEmpty: false }, (row) => matrix.push(Array.isArray(row.values) ? row.values.slice(1) : []));
  if (matrix.length === 0) return errorResult("empty_sheet", "input sheet is empty");

  const header = (matrix[0] ?? []).map((v) => String(v ?? ""));
  const colIdx = resolveColumn(header, column);
  if (colIdx < 0) return errorResult("invalid_config", `column not found: ${JSON.stringify(column)}`);

  const out = new ExcelJS.Workbook();
  const ws = out.addWorksheet("Deduped");
  ws.addRow(header);

  const seen: string[] = [];
  let kept = 0, dropped = 0;
  for (let i = 1; i < matrix.length; i++) {
    const row = matrix[i] ?? [];
    const value = String(row[colIdx] ?? "");
    const norm = caseSensitive ? value : value.toLowerCase();
    if (seen.some((s) => normalisedLevenshtein(s, norm) <= threshold)) {
      dropped += 1;
      continue;
    }
    seen.push(norm);
    ws.addRow(row);
    kept += 1;
  }

  const outRef = `fuzzy-${ref.ref}`;
  const outPath = join(ctx.scratchDir, outRef);
  await out.xlsx.writeFile(outPath);
  const outBytes = sizeOrFallback(outPath, 0);

  return {
    ok: true,
    outputs: { keptCount: kept, droppedCount: dropped, threshold },
    fileRefs: [{ ref: outRef, bytes: outBytes, sha256: "", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", filename: ref.filename ?? "fuzzy.xlsx" }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function resolveColumn(header: string[], col: unknown): number {
  if (typeof col === "number" && Number.isInteger(col) && col > 0 && col <= header.length) return col - 1;
  return header.indexOf(String(col));
}

function normalisedLevenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const max = Math.max(a.length, b.length);
  if (max === 0) return 0;
  return levenshtein(a, b) / max;
}

function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev: number[] = Array.from({ length: a.length + 1 }, (_, i) => i);
  for (let j = 1; j <= b.length; j++) {
    const curr: number[] = [j];
    for (let i = 1; i <= a.length; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr.push(Math.min(curr[i - 1]! + 1, prev[i]! + 1, prev[i - 1]! + cost));
    }
    prev = curr;
  }
  return prev[a.length]!;
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
