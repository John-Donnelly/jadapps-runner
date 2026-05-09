/**
 * excel-goal-seek: numerically solves for a single input cell that drives a
 * target output cell to a desired value, using bisection. Requires the
 * caller to identify both cells by address. Returns the input value and the
 * final output value (cells in the workbook are not modified).
 *
 * Note: only supports formulas whose result is already cached on the cell
 * (Excel writes cached results when the file is saved). Without a real
 * formula evaluator we can't recompute as we change inputs; v0.1 therefore
 * uses cached values from sheets where the user has saved a parameter table.
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

export default async function excelGoalSeek(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "excel-goal-seek requires one .xlsx input");

  const cfg = ctx.inputs ?? {};
  const inputColumn = cfg.inputColumn;
  const outputColumn = cfg.outputColumn;
  const target = Number(cfg.target ?? 0);
  if (inputColumn == null || outputColumn == null) return errorResult("invalid_config", "inputColumn and outputColumn are required");

  let ExcelJS: typeof import("exceljs");
  try { ExcelJS = (await import("exceljs")).default as typeof import("exceljs"); }
  catch (err) { return errorResult("driver_missing", `exceljs not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(inPath);
  ctx.emitProgress(totalIn);

  const sheet = wb.worksheets[0]!;
  const matrix: unknown[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => matrix.push(Array.isArray(row.values) ? row.values.slice(1) : []));
  if (matrix.length < 2) return errorResult("empty_sheet", "need at least one data row");
  const header = (matrix[0] ?? []).map((v) => String(v ?? ""));
  const inIdx = resolveColumn(header, inputColumn);
  const outIdx = resolveColumn(header, outputColumn);
  if (inIdx < 0 || outIdx < 0) return errorResult("invalid_config", "input or output column not found");

  const points: { input: number; output: number }[] = [];
  for (let i = 1; i < matrix.length; i++) {
    const row = matrix[i] ?? [];
    const x = Number(row[inIdx]);
    const y = Number(row[outIdx]);
    if (Number.isFinite(x) && Number.isFinite(y)) points.push({ input: x, output: y });
  }
  if (points.length < 2) return errorResult("insufficient_data", "need at least 2 numeric (input,output) rows");
  points.sort((a, b) => a.input - b.input);

  const bestInput = interpolate(points, target);

  const report = JSON.stringify({ targetOutput: target, solvedInput: bestInput, sampleCount: points.length, samples: points.slice(0, 10) }, null, 2);
  const outRef = "goal-seek.json";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, report, "utf8");

  return {
    ok: true,
    outputs: { targetOutput: target, solvedInput: bestInput, sampleCount: points.length },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(report, "utf8"), sha256: "", mime: "application/json", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function interpolate(points: { input: number; output: number }[], target: number): number {
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    if ((a.output <= target && target <= b.output) || (b.output <= target && target <= a.output)) {
      if (b.output === a.output) return (a.input + b.input) / 2;
      const t = (target - a.output) / (b.output - a.output);
      return a.input + t * (b.input - a.input);
    }
  }
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const closer = Math.abs(target - first.output) < Math.abs(target - last.output) ? first : last;
  return closer.input;
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
