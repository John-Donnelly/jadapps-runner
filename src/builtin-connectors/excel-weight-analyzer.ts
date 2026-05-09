/**
 * excel-weight-analyzer: produces per-group descriptive statistics for a
 * numeric column, weighted by an optional weight column. Stats: count,
 * weighted mean, weighted standard deviation, weighted median (true if
 * weights provided), min, max.
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

interface GroupStats {
  group: string;
  n: number;
  weightSum: number;
  mean: number;
  stddev: number;
  median: number;
  min: number;
  max: number;
}

export default async function excelWeightAnalyzer(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "excel-weight-analyzer requires one .xlsx input");

  const cfg = ctx.inputs ?? {};
  const sheetSel = cfg.sheet ?? 1;
  const valueColumn = cfg.valueColumn;
  const weightColumn = cfg.weightColumn;
  const groupBy = cfg.groupBy;
  if (valueColumn == null) return errorResult("invalid_config", "valueColumn is required");

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
  if (matrix.length < 2) return errorResult("empty_sheet", "need at least one data row");

  const header = (matrix[0] ?? []).map((v) => String(v ?? ""));
  const valueIdx = resolveColumn(header, valueColumn);
  const weightIdx = weightColumn != null ? resolveColumn(header, weightColumn) : -1;
  const groupIdx = groupBy != null ? resolveColumn(header, groupBy) : -1;
  if (valueIdx < 0) return errorResult("invalid_config", "valueColumn not found");

  const groups = new Map<string, { value: number; weight: number }[]>();
  for (let r = 1; r < matrix.length; r++) {
    const row = matrix[r] ?? [];
    const value = Number(row[valueIdx]);
    if (!Number.isFinite(value)) continue;
    const weight = weightIdx >= 0 ? Number(row[weightIdx]) : 1;
    if (!Number.isFinite(weight) || weight <= 0) continue;
    const key = groupIdx >= 0 ? String(row[groupIdx] ?? "(blank)") : "(all)";
    const list = groups.get(key) ?? [];
    list.push({ value, weight });
    groups.set(key, list);
  }

  const stats: GroupStats[] = [];
  for (const [groupKey, samples] of groups) {
    samples.sort((a, b) => a.value - b.value);
    const weightSum = samples.reduce((s, p) => s + p.weight, 0);
    const mean = samples.reduce((s, p) => s + p.value * p.weight, 0) / weightSum;
    const variance = samples.reduce((s, p) => s + p.weight * (p.value - mean) ** 2, 0) / weightSum;
    const stddev = Math.sqrt(variance);
    let cumulative = 0;
    const half = weightSum / 2;
    let median = samples[0]?.value ?? 0;
    for (const s of samples) {
      cumulative += s.weight;
      if (cumulative >= half) { median = s.value; break; }
    }
    stats.push({
      group: groupKey,
      n: samples.length,
      weightSum,
      mean,
      stddev,
      median,
      min: samples[0]?.value ?? NaN,
      max: samples[samples.length - 1]?.value ?? NaN,
    });
  }

  const out = JSON.stringify({ groupCount: stats.length, weighted: weightIdx >= 0, stats }, null, 2);
  const outRef = "weight-stats.json";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, out, "utf8");

  return {
    ok: true,
    outputs: { groupCount: stats.length, weighted: weightIdx >= 0 },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(out, "utf8"), sha256: "", mime: "application/json", filename: outRef }],
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
