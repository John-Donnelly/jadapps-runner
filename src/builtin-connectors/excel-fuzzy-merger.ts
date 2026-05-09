/**
 * excel-fuzzy-merger: fuzzy left join across two .xlsx inputs. For each left
 * row, picks the right row whose key column has the smallest normalised
 * Levenshtein distance. Rows beyond the threshold are reported as unmatched.
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

export default async function excelFuzzyMerger(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  if (!Array.isArray(ctx.fileRefs) || ctx.fileRefs.length < 2) {
    return errorResult("missing_input", "excel-fuzzy-merger requires two .xlsx inputs");
  }

  const cfg = ctx.inputs ?? {};
  const leftKey = cfg.leftKey;
  const rightKey = cfg.rightKey ?? leftKey;
  const threshold = Math.max(0, Math.min(1, Number(cfg.threshold ?? 0.25)));
  const caseSensitive = cfg.caseSensitive === true;
  if (leftKey == null) return errorResult("invalid_config", "leftKey is required");

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

  const sheetA = wbA.worksheets[0]!;
  const sheetB = wbB.worksheets[0]!;
  const matA = sheetToMatrix(sheetA);
  const matB = sheetToMatrix(sheetB);
  if (matA.length === 0 || matB.length === 0) return errorResult("empty_sheet", "one of the inputs is empty");

  const headerA = (matA[0] ?? []).map((v) => String(v ?? ""));
  const headerB = (matB[0] ?? []).map((v) => String(v ?? ""));
  const keyAIdx = resolveColumn(headerA, leftKey);
  const keyBIdx = resolveColumn(headerB, rightKey);
  if (keyAIdx < 0 || keyBIdx < 0) return errorResult("invalid_config", "key column not found");

  const norm = (s: string) => caseSensitive ? s : s.toLowerCase();
  const rightKeys = matB.slice(1).map((row) => norm(String(row[keyBIdx] ?? "")));

  const out = new ExcelJS.Workbook();
  const ws = out.addWorksheet("Merged");
  const rightTailHeader = headerB.filter((_, i) => i !== keyBIdx).map((h) => `${h}_right`);
  ws.addRow([...headerA, ...rightTailHeader, "_match_score"]);

  let matched = 0, unmatched = 0;
  for (let i = 1; i < matA.length; i++) {
    const row = matA[i] ?? [];
    const target = norm(String(row[keyAIdx] ?? ""));
    let bestIdx = -1, bestDist = Infinity;
    for (let j = 0; j < rightKeys.length; j++) {
      const d = normalisedLevenshtein(target, rightKeys[j]!);
      if (d < bestDist) { bestDist = d; bestIdx = j; }
    }
    if (bestIdx >= 0 && bestDist <= threshold) {
      const rightRow = matB[bestIdx + 1] ?? [];
      const tail = rightRow.filter((_, j) => j !== keyBIdx);
      ws.addRow([...row, ...tail, 1 - bestDist]);
      matched += 1;
    } else {
      ws.addRow([...row, ...rightTailHeader.map(() => null), 0]);
      unmatched += 1;
    }
  }

  const outRef = "fuzzy-merged.xlsx";
  const outPath = join(ctx.scratchDir, outRef);
  await out.xlsx.writeFile(outPath);
  const outBytes = sizeOrFallback(outPath, 0);

  return {
    ok: true,
    outputs: { matched, unmatched, threshold },
    fileRefs: [{ ref: outRef, bytes: outBytes, sha256: "", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function sheetToMatrix(sheet: import("exceljs").Worksheet): unknown[][] {
  const matrix: unknown[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => matrix.push(Array.isArray(row.values) ? row.values.slice(1) : []));
  return matrix;
}

function resolveColumn(header: string[], col: unknown): number {
  if (typeof col === "number" && Number.isInteger(col) && col > 0 && col <= header.length) return col - 1;
  return header.indexOf(String(col));
}

function normalisedLevenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const max = Math.max(a.length, b.length);
  if (max === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return 1;
  let prev: number[] = Array.from({ length: a.length + 1 }, (_, i) => i);
  for (let j = 1; j <= b.length; j++) {
    const curr: number[] = [j];
    for (let i = 1; i <= a.length; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr.push(Math.min(curr[i - 1]! + 1, prev[i]! + 1, prev[i - 1]! + cost));
    }
    prev = curr;
  }
  return prev[a.length]! / max;
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
